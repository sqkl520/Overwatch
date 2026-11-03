<#
  uia-probe.ps1 - read-only / low-risk Windows UI Automation driver for the
  Claude Code desktop app (Electron / Chromium).

  PURPOSE
    Prove out (or disprove) the mechanics needed by an external watchdog to
    deliver a line of text into a running Claude Code desktop session.
    Every subcommand here is READ-ONLY or DRAFT-ONLY. This script never
    invokes the Send button. Real delivery is deliberately not implemented.

  SAFETY MODEL
    * Never clicks by screen coordinate. Every action is resolved through the
      UIA tree by name, re-queried immediately before use.
    * If a session cannot be resolved to exactly one row, it ABORTS. It does
      not "click something close".
    * The composer is resolved by name 'Prompt' AND the ProseMirror class.
      A bare FindFirst(Edit) is a bug on this app: the window can also hold a
      'Terminal input' editor, and a blind first-match can type into it.
    * Nothing is written into the composer unless the caller asked for it, and
      every write is read back.

  SUBCOMMANDS
    enum-windows            List candidate top-level windows + why each is or
                            is not a valid target.
    list-sessions           List session rows with UIA locator data.
    get-status              Report which session row is selected.
    read-prompt             Print the composer's current value.
    write-prompt <text>     Set the composer value, then read it back.
    clear-prompt            Empty the composer, then read it back.
    dry-run-send <text>     write-prompt + verification, then report which
                            control *would* be invoked. Does not invoke it.

  OPTIONS
    -Match <s>       Session name (or unique prefix) for session-scoped use.
    -TextFile <p>    Read the text payload from a UTF-8 file. Prefer this for
                     non-ASCII payloads: PowerShell 5.1 argv is decoded with
                     the system ANSI codepage, so Chinese literals on the
                     command line can arrive corrupted.
    -Hwnd <n>        Pin the target window by HWND instead of auto-selecting.
    -Json            Machine-readable output.
    -Retries <n>     Re-query attempts per operation (default 3).
    -RetryDelayMs    Delay between attempts (default 120).
    -AllowAmbiguous  Permit a multi-row name match. Off by default; an
                     ambiguous match aborts so we never guess.

  EXIT CODES
    0 ok            2 target not found      3 verification mismatch
    4 normalized-only mismatch               5 ambiguous match (aborted)
    6 target window unresolved/ambiguous     7 UIA error / retries exhausted
    8 usage error

  NOTE ON ELEMENT IDENTITY
    UIA element handles go stale whenever the view changes (session switch,
    re-render). Do not cache AutomationElement objects across operations.
    Every function below re-queries from the window handle.
#>

# ------------------------------------------------------------------- argv ----
#
# Deliberately NO param() block. PowerShell 5.1's -File argument binder proved
# unusable here: switch parameters intermittently mis-bind and take the script's
# own stdout as a Boolean value, and partial-name matching means a new UIA field
# could silently start satisfying a parameter name. For a CLI that a background
# daemon invokes, explicit argv parsing is both predictable and debuggable.
#
# Accepted forms:
#   -Name value      -Name:value      -SwitchName      --name value
# Parsing stops being clever after the first non-dash token: that token is the
# command and the next one is the payload. Everything else must be a flag.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$script:Opt = @{
  Command         = $null
  Text            = $null
  Match           = $null
  TextFile        = $null
  Hwnd            = [int64]0
  Json            = $false
  Retries         = 3
  RetryDelayMs    = 120
  AllowAmbiguous  = $false
  AllowMinimized  = $false
}

$script:ArgErrors = New-Object System.Collections.ArrayList

function Get-NormalizedArgName {
  param([string]$Raw)
  return ($Raw -replace '^--?', '').ToLowerInvariant()
}

$argv = @($args)
$script:ArgIndex = 0
$sawCommand = $false
while ($script:ArgIndex -lt $argv.Count) {
  $tok = [string]$argv[$script:ArgIndex]
  if ($tok -match '^--?[A-Za-z]') {
    $inline = $null
    $nameRaw = $tok
    $eq = $tok.IndexOf(':')
    $eq2 = $tok.IndexOf('=')
    $cut = -1
    if ($eq -gt 0 -and ($eq2 -lt 0 -or $eq -lt $eq2)) { $cut = $eq }
    elseif ($eq2 -gt 0) { $cut = $eq2 }
    if ($cut -gt 0) {
      $inline = $tok.Substring($cut + 1)
      $nameRaw = $tok.Substring(0, $cut)
    }
    $name = Get-NormalizedArgName $nameRaw

    # Helper: take the next argv token unless an inline value was supplied.
    # NOTE: a scriptblock runs in its own scope, so the index must be
    # script-scoped or the consumed token gets re-read as a positional.
    $takeValue = {
      if ($null -ne $inline) { return $inline }
      if ($script:ArgIndex + 1 -lt $argv.Count) {
        $nxt = [string]$argv[$script:ArgIndex + 1]
        if ($nxt -notmatch '^--?[A-Za-z]') { $script:ArgIndex++; return $nxt }
      }
      return $null
    }

    switch ($name) {
      'json'           { $script:Opt.Json = $true }
      'allowambiguous' { $script:Opt.AllowAmbiguous = $true }
      'allowminimized' { $script:Opt.AllowMinimized = $true }
      'match'          { $script:Opt.Match = & $takeValue }
      'textfile'       { $script:Opt.TextFile = & $takeValue }
      'text'           { $script:Opt.Text = & $takeValue }
      'hwnd' {
        $v = & $takeValue
        $parsed = [int64]0
        if ([int64]::TryParse([string]$v, [ref]$parsed)) { $script:Opt.Hwnd = $parsed }
        else { [void]$script:ArgErrors.Add("bad -Hwnd value: '$v'") }
      }
      'retries' {
        $v = & $takeValue
        $parsed = 0
        if ([int]::TryParse([string]$v, [ref]$parsed) -and $parsed -ge 1) { $script:Opt.Retries = $parsed }
        else { [void]$script:ArgErrors.Add("bad -Retries value: '$v'") }
      }
      'retrydelayms' {
        $v = & $takeValue
        $parsed = 0
        if ([int]::TryParse([string]$v, [ref]$parsed) -and $parsed -ge 0) { $script:Opt.RetryDelayMs = $parsed }
        else { [void]$script:ArgErrors.Add("bad -RetryDelayMs value: '$v'") }
      }
      default { [void]$script:ArgErrors.Add("unknown option: '$tok'") }
    }
    $script:ArgIndex++
    continue
  }

  # Positional token.
  if (-not $sawCommand) {
    $script:Opt.Command = $tok
    $sawCommand = $true
  } elseif ($null -eq $script:Opt.Text) {
    $script:Opt.Text = $tok
  } else {
    [void]$script:ArgErrors.Add("unexpected extra argument: '$tok'")
  }
  $script:ArgIndex++
}

# Bind to locals so the rest of the script reads naturally.
$Command        = $script:Opt.Command
$Text           = $script:Opt.Text
$Match          = $script:Opt.Match
$TextFile       = $script:Opt.TextFile
$Hwnd           = $script:Opt.Hwnd
$Json           = $script:Opt.Json
$Retries        = $script:Opt.Retries
$RetryDelayMs   = $script:Opt.RetryDelayMs
$AllowAmbiguous = $script:Opt.AllowAmbiguous
$AllowMinimized = $script:Opt.AllowMinimized

# Console output encoding: this host defaults to GB2312, which mangles session
# names when output is piped. Emit UTF-8 so callers get intact text.
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

# ---------------------------------------------------------------- interop ----

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

if (-not ('UiaProbe.Win32' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace UiaProbe {
  public class Win32 {
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetFocus();

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);

    [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
      public int cbSize; public int flags;
      public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
      public RECT rcCaret;
    }
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO gi);

    public class WinInfo {
      public long Hwnd; public uint Pid; public string Title; public string Class;
      public bool Visible; public bool Minimized; public int X, Y, W, H;
      public string Proc;
    }

    public static List<WinInfo> TopLevel() {
      var res = new List<WinInfo>();
      EnumWindows(delegate(IntPtr h, IntPtr l) {
        var wi = new WinInfo();
        uint pid; GetWindowThreadProcessId(h, out pid);
        wi.Hwnd = h.ToInt64(); wi.Pid = pid;
        var t = new StringBuilder(512); GetWindowTextW(h, t, 512); wi.Title = t.ToString();
        var c = new StringBuilder(256); GetClassNameW(h, c, 256); wi.Class = c.ToString();
        wi.Visible = IsWindowVisible(h); wi.Minimized = IsIconic(h);
        RECT r; GetWindowRect(h, out r);
        wi.X = r.Left; wi.Y = r.Top; wi.W = r.Right - r.Left; wi.H = r.Bottom - r.Top;
        res.Add(wi);
        return true;
      }, IntPtr.Zero);
      return res;
    }

    public static string ForegroundInfo() {
      IntPtr fg = GetForegroundWindow();
      uint pid; GetWindowThreadProcessId(fg, out pid);
      var t = new StringBuilder(512); GetWindowTextW(fg, t, 512);
      return fg.ToInt64() + "|" + pid + "|" + t.ToString();
    }

    // Keyboard focus as the OS sees it for the foreground thread.
    public static string FocusInfo() {
      IntPtr fg = GetForegroundWindow();
      uint pid; uint tid = GetWindowThreadProcessId(fg, out pid);
      var gi = new GUITHREADINFO();
      gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
      if (!GetGUIThreadInfo(tid, ref gi)) return "ERR";
      return gi.hwndFocus.ToInt64() + "|" + gi.hwndCaret.ToInt64();
    }
  }
}
"@
}

# --------------------------------------------------------------- helpers ----

$script:AttemptLog = New-Object System.Collections.ArrayList

function Write-Diag {
  param([string]$Message)
  if (-not $Json) { [Console]::Error.WriteLine("[uia-probe] $Message") }
}

function Get-RectString {
  param($Element)
  try {
    $b = $Element.Current.BoundingRectangle
    if ([double]::IsInfinity($b.X) -or [double]::IsNaN($b.X) -or [double]::IsInfinity($b.Width)) {
      return 'EMPTY'
    }
    return ('{0},{1} {2}x{3}' -f [int]$b.X, [int]$b.Y, [int]$b.Width, [int]$b.Height)
  } catch { return 'ERR' }
}

function Get-RectObj {
  param($Element)
  $b = $Element.Current.BoundingRectangle
  if ([double]::IsInfinity($b.X) -or [double]::IsNaN($b.X)) { return $null }
  return [pscustomobject]@{ X = [int]$b.X; Y = [int]$b.Y; W = [int]$b.Width; H = [int]$b.Height }
}

function Get-SafeName {
  param($Element)
  try { return [string]$Element.Current.Name } catch { return '' }
}

function Normalize-Space {
  param([string]$s)
  if ($null -eq $s) { return '' }
  return ([regex]::Replace($s, '\s+', ' ')).Trim()
}

# Custom exception carrying an exit code so the top-level handler can be dumb.
# ProbeRetryable marks a transient condition that is worth retrying even though
# it carries a final exit code. Without this distinction a transient
# "subtree not built yet" would be classified as a logic error and never
# retried - measured: it made a healthy window look permanently unusable.
function New-ProbeError {
  param([string]$Message, [int]$Code, [switch]$Retryable)
  $e = New-Object System.Exception($Message)
  $e.Data['ProbeExitCode'] = $Code
  if ($Retryable) { $e.Data['ProbeRetryable'] = $true }
  return $e
}

<#
  Retry wrapper.

  Important: the scriptblock must RE-QUERY the UIA tree itself. Retrying a
  cached AutomationElement is useless - the stale handle throws identically
  forever. So "one attempt" here means "one full resolve-from-scratch".
  Attempts are recorded so callers can report how many were needed.
#>
function Invoke-WithRetry {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Action,
    [string]$Label = 'op',
    [int]$MaxAttempts = 3,
    [int]$DelayMs = 120
  )
  $last = $null
  for ($i = 1; $i -le $MaxAttempts; $i++) {
    try {
      $result = & $Action
      [void]$script:AttemptLog.Add([pscustomobject]@{ Op = $Label; Attempt = $i; Ok = $true })
      return $result
    } catch {
      $last = $_
      $msg = $_.Exception.Message
      # Logic errors (not found / ambiguous) must not be retried: repeating them
      # cannot change the answer and only turns 20s into 100s. Transient errors
      # opt in via ProbeRetryable and are retried even though they carry a code.
      if ($_.Exception.Data.Contains('ProbeExitCode') -and -not $_.Exception.Data.Contains('ProbeRetryable')) { throw }
      [void]$script:AttemptLog.Add([pscustomobject]@{ Op = $Label; Attempt = $i; Ok = $false; Error = $msg })
      if ($i -lt $MaxAttempts) { Start-Sleep -Milliseconds $DelayMs }
    }
  }
  $err = New-ProbeError ("{0} failed after {1} attempts: {2}" -f $Label, $MaxAttempts, $last.Exception.Message) 7
  throw $err
}

# ------------------------------------------------------- window selection ----

<#
  Find candidate windows.

  Filters, in order of how much they actually buy us:
    1. process name is 'claude' (there are ~21 such processes; only one owns
       a real GUI window, so process name alone is far too loose)
    2. top-level, class Chrome_WidgetWin_1, VISIBLE, not minimized
    3. large enough to be the main window (>= 800x600)
    4. the UIA subtree actually contains a 'Sidebar' group AND a 'Prompt'
       composer. This is the check that matters: it rejects splash screens,
       hidden helper windows and the notification host.
#>
function Get-CandidateWindows {
  $procs = @{}
  foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
    if ($p.ProcessName -match '^claude') { $procs[[int]$p.Id] = $p.ProcessName }
  }

  $out = @()
  foreach ($wi in [UiaProbe.Win32]::TopLevel()) {
    if (-not $procs.ContainsKey([int]$wi.Pid)) { continue }
    $row = [pscustomobject]@{
      Hwnd      = $wi.Hwnd
      Pid       = $wi.Pid
      Title     = $wi.Title
      Class     = $wi.Class
      Visible   = $wi.Visible
      Minimized = $wi.Minimized
      Rect      = ('{0},{1} {2}x{3}' -f $wi.X, $wi.Y, $wi.W, $wi.H)
      Usable    = $false
      Reason    = ''
      HasSidebar = $false
      HasPrompt  = $false
    }

    if ($wi.Class -ne 'Chrome_WidgetWin_1') { $row.Reason = 'not main widget class'; $out += $row; continue }
    if (-not $wi.Visible) { $row.Reason = 'hidden'; $out += $row; continue }
    if ($wi.Minimized -and -not $AllowMinimized) { $row.Reason = 'minimized'; $out += $row; continue }
    # A minimized Electron window reports a bogus 160x28 rect, so the size
    # heuristic can only be applied to a normal-state window.
    if (-not $wi.Minimized -and ($wi.W -lt 800 -or $wi.H -lt 600)) {
      $row.Reason = 'too small to be main window'; $out += $row; continue
    }

    # Structural confirmation via UIA.
    #
    # Retried deliberately: when the window is mid-render (for example the
    # frame has been restored but the subtree has not been rebuilt yet) a single
    # pass returns no Sidebar even though the window is perfectly healthy.
    # Measured: this happened repeatedly while the user was interacting with the
    # app, and made otherwise-valid windows disappear from the candidate list.
    $attempts = 3
    for ($a = 1; $a -le $attempts; $a++) {
      try {
        $el = $AE::FromHandle([IntPtr]$wi.Hwnd)
        if ($null -eq $el) { $row.Reason = 'FromHandle returned null'; break }
        $sb = Find-SidebarElement -Window $el
        $pm = Find-ComposerElement -Window $el -Quiet
        $row.HasSidebar = ($null -ne $sb)
        $row.HasPrompt = ($null -ne $pm)
        if ($null -ne $sb -and $null -ne $pm) {
          $row.Usable = $true
          $row.Reason = 'ok'
          break
        }
        if ($null -eq $sb) { $row.Reason = 'no Sidebar group in UIA subtree' }
        else { $row.Reason = 'no Prompt composer in UIA subtree' }
      } catch {
        $row.Reason = 'UIA probe failed: ' + $_.Exception.Message
      }
      if ($a -lt $attempts) { Start-Sleep -Milliseconds 150 }
    }
    $out += $row
  }
  return $out
}

function Get-TargetWindow {
  param([int64]$PreferredHwnd = 0)

  $cands = Get-CandidateWindows
  $usable = @($cands | Where-Object { $_.Usable })

  if ($PreferredHwnd -ne 0) {
    $hit = @($usable | Where-Object { $_.Hwnd -eq $PreferredHwnd })
    if ($hit.Count -ne 1) {
      throw (New-ProbeError ("pinned hwnd {0} is not a usable target (usable: {1})" -f `
            $PreferredHwnd, (($usable | ForEach-Object { $_.Hwnd }) -join ',')) 6)
    }
    return [pscustomobject]@{ Hwnd = $hit[0].Hwnd; Element = $AE::FromHandle([IntPtr]$hit[0].Hwnd); Info = $hit[0] }
  }

  if ($usable.Count -eq 0) {
    $why = ($cands | ForEach-Object { '{0}:{1}' -f $_.Hwnd, $_.Reason }) -join '; '
    throw (New-ProbeError ("no usable Claude window found. candidates => $why") 6)
  }
  if ($usable.Count -gt 1) {
    $why = ($usable | ForEach-Object { '{0}:{1}' -f $_.Hwnd, $_.Rect }) -join '; '
    throw (New-ProbeError ("ambiguous target: {0} usable Claude windows ({1}). Pass -Hwnd." -f $usable.Count, $why) 6)
  }
  return [pscustomobject]@{ Hwnd = $usable[0].Hwnd; Element = $AE::FromHandle([IntPtr]$usable[0].Hwnd); Info = $usable[0] }
}

# ------------------------------------------------------------ UIA lookups ----

function Find-SidebarElement {
  param($Window)
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Sidebar')),
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Group))
  )
  $sb = $Window.FindFirst($TS::Descendants, $cond)
  if ($null -eq $sb) { return $null }

  # Do NOT require populated children here. Measured: the sidebar group can
  # exist while its subtree is still empty (buttons=0, children=0) during a
  # re-render. Treating that as "no sidebar" made healthy windows vanish from
  # the candidate list, which is how valid targets got rejected. Emptiness is
  # a transient state, so it is handled by the caller's retry / row check, not
  # by rejecting the window.
  return $sb
}

<#
  Resolve the composer.

  Deliberately NOT FindFirst(ControlType.Edit). On this app the window can
  simultaneously expose a 'Prompt' editor (tiptap/ProseMirror) and a
  'Terminal input' editor. A blind first-match can land in the terminal and
  type there - observed during recon. So:
    - require Name == 'Prompt'
    - require the ProseMirror class when available
    - if the match count is not exactly 1, abort
#>
function Find-ComposerElement {
  param($Window, [switch]$Quiet)

  $byName = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Prompt')),
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit))
  )
  $hits = @($Window.FindAll($TS::Descendants, $byName) | Where-Object { $null -ne $_ })

  if ($hits.Count -eq 0) {
    if ($Quiet) { return $null }
    throw (New-ProbeError "composer not found: no Edit named 'Prompt'" 2)
  }
  if ($hits.Count -gt 1) {
    $detail = ($hits | ForEach-Object { '{0}/{1}@{2}' -f (Get-SafeName $_), $_.Current.ClassName, (Get-RectString $_) }) -join '; '
    throw (New-ProbeError ("ambiguous composer: {0} Edits named 'Prompt' ({1})" -f $hits.Count, $detail) 2)
  }

  $el = $hits[0]
  $cls = ''
  try { $cls = [string]$el.Current.ClassName } catch { }
  if ($cls -and ($cls -notmatch 'ProseMirror')) {
    if ($Quiet) { return $null }
    throw (New-ProbeError ("composer candidate has unexpected class '$cls' (expected tiptap ProseMirror); refusing to type into it") 2)
  }

  $vpOk = $true
  try { $null = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch { $vpOk = $false }
  if (-not $vpOk) {
    if ($Quiet) { return $null }
    throw (New-ProbeError "composer does not expose ValuePattern" 2)
  }
  return $el
}

<#
  Session rows.

  The sidebar is FLAT: session rows are direct siblings of nav buttons such as
  New / Routines / Customize (verified: 40 buttons all report
  parent=Group[Sidebar]). There is therefore no structural container that
  isolates sessions, so we discriminate on properties that are stable across
  re-renders and independent of list order:

    - ControlType.Button
    - name not empty and not starting with 'More options for' (per-row kebab)
    - height >= 40   (rows are 44-45px; nav rows are 26-27px)
    - width  >= 300  (kebab buttons are 20px)
    - rect inside the sidebar's own bounds
    - name not in the known nav-label set

  Nothing here uses a fixed y coordinate.
#>
$script:NavLabels = @(
  'New', 'Routines', 'Customize', 'Cowork', 'Code', 'More navigation items',
  'View all', 'Search', 'Group by', 'Sort', 'Menu', 'Hide sidebar', 'Back',
  'Forward', 'New session'
)

function Get-SessionRows {
  param($Sidebar, [switch]$IncludeKebab)

  $sbRect = Get-RectObj $Sidebar
  if ($null -eq $sbRect) { throw (New-ProbeError 'sidebar has no bounding rectangle' 7) }

  $bc = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
  $rows = @()
  $idx = 0
  foreach ($b in $Sidebar.FindAll($TS::Descendants, $bc)) {
    $name = Get-SafeName $b
    if ($name.Trim().Length -eq 0) { continue }

    $isKebab = $name -match '^More options for '
    if ($isKebab -and -not $IncludeKebab) { continue }

    $r = Get-RectObj $b
    if ($null -eq $r) { continue }

    if (-not $isKebab) {
      if ($r.H -lt 40) { continue }
      if ($r.W -lt 300) { continue }
      if ($script:NavLabels -contains $name) { continue }
      # Horizontal containment must hold: a session row starts at the sidebar's
      # left edge. Vertical containment must NOT be enforced - the sidebar's
      # reported height (1030) is smaller than the list it scrolls, so rows that
      # are legitimately in the sidebar can sit below it (observed at y=1353 for
      # a 1030-tall sidebar). Enforcing y-bounds silently dropped 4 of 20 real
      # sessions.
      if ($r.X -lt $sbRect.X -or ($r.X + $r.W) -gt ($sbRect.X + $sbRect.W + 2)) { continue }
    }

    $selected = $null
    try {
      $si = $b.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $selected = [bool]$si.Current.IsSelected
    } catch { $selected = $null }

    $methods = @()
    try { $null = $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $methods += 'Invoke' } catch { }
    try { $null = $b.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $methods += 'SelectionItem' } catch { }

    try {
      $rid = $b.GetRuntimeId()
      $uid = ($rid | ForEach-Object { $_.ToString() }) -join '.'
    } catch { $uid = '' }

    $rows += [pscustomobject]@{
      Index       = $idx
      Name        = $name
      Normalized  = (Normalize-Space $name)
      Rect        = ('{0},{1} {2}x{3}' -f $r.X, $r.Y, $r.W, $r.H)
      Y           = $r.Y
      Height      = $r.H
      Selected    = $selected
      IsKebab     = $isKebab
      Enabled     = $true
      Methods     = ($methods -join '+')
      RuntimeId   = $uid
      Element     = $b
    }
    $idx++
  }
  return $rows
}

<#
  Resolve one session row by name.

  Match ladder, most strict first:
    1. exact normalized equality
    2. row name starts with the query followed by a space (i.e. the query is
       the session title and the rest is project + timestamp)
  If either rung yields more than one row, ABORT unless -AllowAmbiguous.
  It never falls back to "the first row", "the nearest row" or a coordinate.
#>
function Resolve-SessionRow {
  param(
    [Parameter(Mandatory = $true)]$Sidebar,
    [Parameter(Mandatory = $true)][string]$Query,
    [switch]$AllowMultiple
  )

  $q = Normalize-Space $Query
  if ($q.Length -eq 0) { throw (New-ProbeError 'empty session query' 8) }

  $rows = Get-SessionRows -Sidebar $Sidebar
  if ($rows.Count -eq 0) { throw (New-ProbeError 'no session rows found in sidebar' 2) }

  $exact = @($rows | Where-Object { $_.Normalized -eq $q })
  if ($exact.Count -eq 1) { return $exact[0] }
  if ($exact.Count -gt 1) {
    if ($AllowMultiple) { return $exact }
    throw (New-ProbeError ("ambiguous session '{0}': {1} exact matches" -f $q, $exact.Count) 5)
  }

  $prefix = @($rows | Where-Object { $_.Normalized -like ($q + ' *') })
  if ($prefix.Count -eq 1) { return $prefix[0] }
  if ($prefix.Count -gt 1) {
    if ($AllowMultiple) { return $prefix }
    $names = ($prefix | ForEach-Object { '(' + $_.Normalized + ')' }) -join ' '
    throw (New-ProbeError ("ambiguous session '{0}': {1} rows start with it: {2}" -f $q, $prefix.Count, $names) 5)
  }

  # Not found. Deliberately do not guess.
  $near = ($rows | Where-Object { $_.Normalized -like ('*' + $q + '*') } | ForEach-Object { '(' + $_.Normalized + ')' }) -join ' '
  $hint = ''
  if ($near) { $hint = " substring matches, not used: $near" }
  throw (New-ProbeError ("session not found: '{0}'. No row matched exactly or as a title prefix.{1}" -f $q, $hint) 2)
}

function Get-ComposerValue {
  param($Composer)
  $vp = $Composer.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  return [string]$vp.Current.Value
}

function Get-ComposerSnapshot {
  param($Composer)
  $raw = Get-ComposerValue $Composer
  return [pscustomobject]@{ Raw = $raw; Length = $raw.Length; IsEmptyish = ($raw.Trim().Length -eq 0) }
}

function Get-SendCandidates {
  param($Window)
  $bc = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
  $out = @()
  foreach ($b in $Window.FindAll($TS::Descendants, $bc)) {
    $n = Get-SafeName $b
    if ($n -notmatch '^(Send|发送)$') { continue }
    $methods = @()
    try { $null = $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $methods += 'Invoke' } catch { }
    $r = Get-RectObj $b
    $out += [pscustomobject]@{
      Name     = $n
      AutomationId = ''
      Class    = $(try { [string]$b.Current.ClassName } catch { '' })
      Enabled  = $(try { [bool]$b.Current.Enabled } catch { $false })
      Rect     = (Get-RectString $b)
      Methods  = ($methods -join '+')
      Element  = $b
    }
  }
  return $out
}

# ------------------------------------------------------------- text input ----

function Get-Payload {
  param([string]$Inline, [string]$File)
  if ($File) {
    if (-not (Test-Path -LiteralPath $File)) { throw (New-ProbeError "text file not found: $File" 8) }
    return [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $File).Path, [System.Text.Encoding]::UTF8)
  }
  return $Inline
}

# Compare composer readback against what we intended to write.
function Compare-Payload {
  param([string]$Intended, [string]$Actual)
  if ($Intended -ceq $Actual) { return 'exact' }
  if ((Normalize-Space $Intended) -ceq (Normalize-Space $Actual)) { return 'normalized' }
  return 'mismatch'
}

<#
  Dry-run set.

  write-prompt and dry-run-send differ ONLY in the reporting tail. The write
  path is identical, so a dry run exercises the exact code that a real send
  would rely on. Neither of them ever invokes Send.
#>
function Invoke-Draft {
  param([string]$Payload, [switch]$DryRun, [string]$SessionMatch)

  if ($null -eq $Payload) { throw (New-ProbeError 'no payload supplied' 8) }

  $tw = Get-TargetWindow -PreferredHwnd $Hwnd

  <#
    Session gate. When the caller names a session, we prove the app is already
    showing that session BEFORE touching the composer. Switching sessions from
    here is deliberately not implemented: an Invoke on a sidebar row would
    change what the user is looking at, and a wrong row means typing into the
    wrong conversation. If the named session is not the active one, abort.
  #>
  $sessionCheck = $null
  if ($SessionMatch) {
    $header = @(Get-CurrentSessionFromHeader -Window $tw.Element)
    $titles = @($header | ForEach-Object { $_.Title })
    $active = $null
    if ($titles.Count -eq 1) { $active = Normalize-Space $titles[0] }
    $want = Normalize-Space $SessionMatch

    $match = $false
    if ($active) {
      if ($active -ceq $want) { $match = $true }
      elseif ($active -like ($want + ' *')) { $match = $true }
      elseif ($want -like ($active + ' *')) { $match = $true }
    }
    $sessionCheck = [pscustomobject]@{
      requested   = $want
      active      = $active
      active_from = 'header rename-session button'
      matched     = $match
    }
    if (-not $match) {
      # Report a distinguishable state; never silently write into whatever is
      # on screen.
      throw (New-ProbeError ("active session does not match '{0}' (active: '{1}'). Refusing to write. Switching sessions is not implemented." -f $want, $active) 2)
    }
  }

  $res = Invoke-WithRetry -Label 'write-prompt' -MaxAttempts $Retries -DelayMs $RetryDelayMs -Action {
    # Re-resolve everything: handles from a previous attempt may be stale.
    $composer = Find-ComposerElement -Window $tw.Element
    $before = Get-ComposerValue $composer
    $vp = $composer.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue($Payload)

    <#
      Poll the read-back. SetValue is NOT synchronous: it hands the text to the
      renderer and returns. Measured on this app, the value can still be the old
      one 60ms later ("verdict=mismatch, intended 8 chars, actual 1") and be
      correct by the time of the next query. A single fixed sleep therefore
      produces false negatives, and a false negative here means reporting a
      failed write that actually succeeded - or rolling back a write that was
      still in flight and leaving the composer empty.

      We poll until the payload appears, up to a budget, and report how long it
      took. Only if it never appears do we call it a mismatch.
    #>
    $deadline = 2500
    $pollSw = [System.Diagnostics.Stopwatch]::StartNew()
    $after = $before
    $seen = 'none'
    while ($pollSw.ElapsedMilliseconds -lt $deadline) {
      $composer2 = Find-ComposerElement -Window $tw.Element
      $after = Get-ComposerValue $composer2
      $seen = Compare-Payload -Intended $Payload -Actual $after
      if ($seen -ne 'mismatch') { break }
      Start-Sleep -Milliseconds 100
    }
    return [pscustomobject]@{
      Before     = $before
      After      = $after
      SettleMs   = $pollSw.ElapsedMilliseconds
      FirstSeen  = $seen
    }
  }

  $verdict = Compare-Payload -Intended $Payload -Actual $res.After

  $rollback = $null
  if ($verdict -eq 'mismatch') {
    try {
      $c = Find-ComposerElement -Window $tw.Element
      $vp = $c.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $vp.SetValue($res.Before)
      Start-Sleep -Milliseconds 300
      $rollback = 'attempted'
    } catch { $rollback = 'failed: ' + $_.Exception.Message }
  }

  return [pscustomobject]@{
    ok           = ($verdict -ne 'mismatch')
    command      = $(if ($DryRun) { 'dry-run-send' } else { 'write-prompt' })
    hwnd         = $tw.Hwnd
    verdict      = $verdict
    settle_ms    = $res.SettleMs
    intended_len = $Payload.Length
    actual_len   = $res.After.Length
    before_len   = $res.Before.Length
    intended     = $Payload
    actual       = $res.After
    escaped_intended = ($Payload -replace "`r", '\r' -replace "`n", '\n')
    escaped_actual   = ($res.After -replace "`r", '\r' -replace "`n", '\n')
    rollback     = $rollback
    session_gate = $sessionCheck
    attempts     = @($script:AttemptLog | Where-Object { $_.Op -eq 'write-prompt' })
  }

  if ($DryRun) {
    # Report, do not act. Identify the control that a real send would invoke.
    $sends = Get-SendCandidates -Window $tw.Element
    $result | Add-Member -NotePropertyName send_candidates -NotePropertyValue @(
      $sends | ForEach-Object {
        [pscustomobject]@{ name = $_.Name; class = $_.Class; enabled = $_.Enabled; rect = $_.Rect; methods = $_.Methods }
      }
    )
    $ok = @($sends | Where-Object { $_.Enabled -and $_.Methods -match 'Invoke' })
    if ($verdict -eq 'mismatch') {
      $would = 'ABORTED: payload verification failed'
    } elseif ($ok.Count -eq 1) {
      $would = "InvokePattern on Button[name='Send'] at $($ok[0].Rect)"
    } elseif ($ok.Count -eq 0) {
      $would = 'ABORTED: no enabled Send button exposing InvokePattern'
    } else {
      $would = "ABORTED: $($ok.Count) Send candidates, ambiguous"
    }
    $result | Add-Member -NotePropertyName would_invoke -NotePropertyValue $would
    $result | Add-Member -NotePropertyName sent -NotePropertyValue $false
  }

  if ($verdict -eq 'mismatch') {
    throw (New-ProbeError ("payload verification failed: intended {0} chars, composer holds {1} chars" -f $Payload.Length, $res.After.Length) 3)
  }
  if ($verdict -eq 'normalized') { $script:NormalizedOnly = $true }
  return $result
}

function Cmd-WritePrompt {
  return (Invoke-Draft -Payload (Get-Payload -Inline $Text -File $TextFile) -SessionMatch $Match)
}

function Cmd-EnumWindows {
  $cands = Get-CandidateWindows
  $usable = @($cands | Where-Object { $_.Usable })
  $rows = @()
  foreach ($c in $cands) {
    $rows += [pscustomobject]@{
      hwnd      = $c.Hwnd
      pid       = $c.Pid
      title     = $c.Title
      class     = $c.Class
      visible   = $c.Visible
      minimized = $c.Minimized
      rect      = $c.Rect
      sidebar   = $c.HasSidebar
      prompt    = $c.HasPrompt
      usable    = $c.Usable
      reason    = $c.Reason
    }
  }
  $result = [pscustomobject]@{
    ok             = $true
    command        = 'enum-windows'
    candidates     = $rows.Count
    usable_count   = $usable.Count
    selection      = $(if ($usable.Count -eq 1) { $usable[0].Hwnd } elseif ($usable.Count -eq 0) { $null } else { 'AMBIGUOUS' })
    windows        = $rows
    claude_processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^claude' } | ForEach-Object { $_.Id }).Count
  }
  return $result
}

function Cmd-ListSessions {
  $tw = Get-TargetWindow -PreferredHwnd $Hwnd
  $sb = Invoke-WithRetry -Label 'find-sidebar' -MaxAttempts $Retries -DelayMs $RetryDelayMs -Action {
    $s = Find-SidebarElement -Window $tw.Element
    if ($null -eq $s) { throw (New-ProbeError 'sidebar disappeared' 7 -Retryable) }
    return $s
  }
  $rows = Invoke-WithRetry -Label 'list-rows' -MaxAttempts $Retries -DelayMs $RetryDelayMs -Action {
    $r = @(Get-SessionRows -Sidebar $sb)
    # An empty list is not an answer. The sidebar is known to be transiently
    # empty while the renderer rebuilds, so retry rather than reporting zero
    # sessions - a caller that trusts "0 sessions" would conclude the workspace
    # is empty and act on that.
    if ($r.Count -eq 0) { throw (New-ProbeError 'sidebar present but no rows materialized yet' 7 -Retryable) }
    return , $r
  }
  $selected = @($rows | Where-Object { $_.Selected -eq $true } | ForEach-Object { $_.Normalized })

  $out = @()
  foreach ($r in $rows) {
    $out += [pscustomobject]@{
      index     = $r.Index
      name      = $r.Name
      normalized = $r.Normalized
      rect      = $r.Rect
      y         = $r.Y
      height    = $r.Height
      selected  = $r.Selected
      methods   = $r.Methods
      runtime_id = $r.RuntimeId
    }
  }
  return [pscustomobject]@{
    ok       = $true
    command  = 'list-sessions'
    hwnd     = $tw.Hwnd
    count    = $out.Count
    selected = $selected
    sessions = $out
  }
}

<#
  The sidebar exposes NO selection state: session rows support InvokePattern
  only, and IsSelected / ItemStatus / HasKeyboardFocus are all empty. So
  "which session is current" cannot be answered from the sidebar.

  The main pane does answer it: the header carries a button named
  "<SessionName>, rename session" (observed at y~49 alongside the Move /
  Terminal / Changes buttons). That is the only place the active session's
  title appears on its own.

  Busy state is likewise observable: while a response is streaming, the
  composer's action button is 'Stop' (not 'Send') and a 'Claude is responding'
  text appears. Both are useful as a guard: sending into a busy session is a
  different (and probably wrong) operation.
#>
function Get-CurrentSessionFromHeader {
  param($Window)
  $found = @()
  try {
    $all = $Window.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  } catch { return $found }
  foreach ($e in $all) {
    try {
      if ($e.Current.ControlType -ne $CT::Button) { continue }
      $n = [string]$e.Current.Name
      if ($n -notmatch ', rename session$') { continue }
      $r = Get-RectObj $e
      if ($null -eq $r) { continue }
      if ($r.X -lt 420) { continue }          # must be in the main pane, not sidebar
      $title = $n -replace ', rename session$', ''
      $found += [pscustomobject]@{ Title = $title.Trim(); Rect = (Get-RectString $e); X = $r.X; Y = $r.Y }
    } catch { }
  }
  return $found
}

function Get-BusyState {
  param($Window)
  $stopBtn = @()
  $responding = @()
  try {
    $bc = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
    foreach ($b in $Window.FindAll($TS::Descendants, $bc)) {
      $n = Get-SafeName $b
      if ($n -notmatch '^(Stop|停止)$') { continue }
      $r = Get-RectObj $b
      if ($null -eq $r -or $r.X -lt 420) { continue }
      $stopBtn += [pscustomobject]@{ Name = $n; Rect = (Get-RectString $b) }
    }
    $tc = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Text)
    foreach ($t in $Window.FindAll($TS::Descendants, $tc)) {
      $n = Get-SafeName $t
      if ($n -notmatch 'is responding|正在回复|Esc to stop') { continue }
      $responding += $n
    }
  } catch { }
  return [pscustomobject]@{
    IsBusy          = (($stopBtn.Count + $responding.Count) -gt 0)
    StopButtons     = $stopBtn
    RespondingTexts = @($responding)
  }
}

function Cmd-GetStatus {
  $tw = Get-TargetWindow -PreferredHwnd $Hwnd
  $res = Invoke-WithRetry -Label 'get-status' -MaxAttempts $Retries -DelayMs $RetryDelayMs -Action {
    $sb = Find-SidebarElement -Window $tw.Element
    if ($null -eq $sb) { throw (New-ProbeError 'sidebar disappeared' 7) }
    $rows = @(Get-SessionRows -Sidebar $sb)
    $composer = Find-ComposerElement -Window $tw.Element
    # .Count is not available on every pipeline result under StrictMode; wrap in
    # @() first so zero rows does not throw.
    $selectionCapable = @(@($rows) | Where-Object { $null -ne $_.Selected }).Count -gt 0
    return [pscustomobject]@{
      Rows      = $rows.Count
      SupportsSelection = $selectionCapable
      Draft     = (Get-ComposerSnapshot -Composer $composer)
      Header    = @(Get-CurrentSessionFromHeader -Window $tw.Element)
      Busy      = (Get-BusyState -Window $tw.Element)
    }
  }
  $headerTitles = @($res.Header | ForEach-Object { $_.Title })
  return [pscustomobject]@{
    ok                  = $true
    command             = 'get-status'
    hwnd                = $tw.Hwnd
    row_count           = $res.Rows
    sidebar_selection   = $res.SupportsSelection
    current_session     = $(if ($headerTitles.Count -eq 1) { $headerTitles[0] } else { $null })
    current_session_src = 'header rename-session button'
    header_candidates   = $headerTitles
    busy                = $res.Busy.IsBusy
    busy_evidence       = @($res.Busy.StopButtons + @($res.Busy.RespondingTexts | ForEach-Object { [pscustomobject]@{ Name = $_; Rect = '' } }))
    draft_length        = $res.Draft.Length
    draft_empty         = $res.Draft.IsEmptyish
    session_view        = ($res.Rows -gt 0)
    window_info         = $tw.Info
  }
}

function Cmd-ReadPrompt {
  $tw = Get-TargetWindow -PreferredHwnd $Hwnd
  $snap = Invoke-WithRetry -Label 'read-prompt' -MaxAttempts $Retries -DelayMs $RetryDelayMs -Action {
    $c = Find-ComposerElement -Window $tw.Element
    return (Get-ComposerSnapshot -Composer $c)
  }
  return [pscustomobject]@{
    ok         = $true
    command    = 'read-prompt'
    hwnd       = $tw.Hwnd
    value      = $snap.Raw
    length     = $snap.Length
    emptyish   = $snap.IsEmptyish
    escaped    = ($snap.Raw -replace "`r", '\r' -replace "`n", '\n' -replace "`t", '\t')
  }
}

<#
  Clear the composer. Read-back verified. An empty tiptap editor still
  reports a newline, so "cleared" means the value trims to empty.
#>
function Cmd-ClearPrompt {
  $tw = Get-TargetWindow -PreferredHwnd $Hwnd
  $res = Invoke-WithRetry -Label 'clear-prompt' -MaxAttempts $Retries -DelayMs $RetryDelayMs -Action {
    $composer = Find-ComposerElement -Window $tw.Element
    $before = Get-ComposerValue $composer
    $vp = $composer.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue('')
    Start-Sleep -Milliseconds 60
    $composer2 = Find-ComposerElement -Window $tw.Element
    $after = Get-ComposerValue $composer2
    return [pscustomobject]@{ Before = $before; After = $after }
  }
  # An empty tiptap editor still reports a newline.
  $cleared = ($res.After.Length -eq 0) -or ($res.After.Trim().Length -eq 0)
  $result = [pscustomobject]@{
    ok         = $cleared
    command    = 'clear-prompt'
    hwnd       = $tw.Hwnd
    before_len = $res.Before.Length
    after_len  = $res.After.Length
    escaped_after = ($res.After -replace "`r", '\r' -replace "`n", '\n')
  }
  if (-not $cleared) { throw (New-ProbeError ("clear verification failed: composer still holds {0} chars" -f $res.After.Length) 3) }
  return $result
}

# ------------------------------------------------------------------- main ----

$script:NormalizedOnly = $false

function Show-Usage {
  $cmds = 'enum-windows', 'list-sessions', 'get-status', 'read-prompt', 'write-prompt', 'clear-prompt', 'dry-run-send'
  if ($Json) {
    [Console]::Out.Write((@{ ok = $false; exit = 8; error = 'usage'; commands = $cmds } | ConvertTo-Json -Depth 3))
    return
  }
  Write-Output ("uia-probe.ps1 - read-only UIA driver for Claude Code desktop")
  Write-Output ("usage: powershell -File uia-probe.ps1 <command> [payload] [-Match s] [-Json]")
  Write-Output ("commands: " + ($cmds -join ', '))
  Write-Output ("options: -Json -Match <s> -TextFile <p> -Hwnd <n> -Retries <n> -RetryDelayMs <n> -AllowAmbiguous -AllowMinimized")
}

function Write-UsageError {
  param([string]$Detail)
  if ($Json) {
    [Console]::Out.Write((@{ ok = $false; exit = 8; error = $Detail } | ConvertTo-Json -Depth 3))
  } else {
    [Console]::Error.WriteLine("[uia-probe] $Detail")
    Show-Usage
  }
}

if (-not $Command) { Show-Usage; exit 8 }

if ($script:ArgErrors.Count -gt 0) {
  Write-UsageError ($script:ArgErrors -join '; ')
  exit 8
}

$result = $null
$exitCode = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()

try {
  switch ($Command.ToLower()) {
    'enum-windows' { $result = Cmd-EnumWindows }
    'list-sessions' { $result = Cmd-ListSessions }
    'get-status' { $result = Cmd-GetStatus }
    'read-prompt' { $result = Cmd-ReadPrompt }
    'write-prompt' { $result = Cmd-WritePrompt }
    'clear-prompt' { $result = Cmd-ClearPrompt }
    'dry-run-send' { $result = Invoke-Draft -Payload (Get-Payload -Inline $Text -File $TextFile) -DryRun -SessionMatch $Match }
    default { Show-Usage; exit 8 }
  }
} catch {
  $code = 7
  if ($_.Exception.Data.Contains('ProbeExitCode')) { $code = [int]$_.Exception.Data['ProbeExitCode'] }
  $exitCode = $code
  $result = [pscustomobject]@{
    ok      = $false
    command = $Command
    exit    = $code
    error   = $_.Exception.Message
    attempts = $script:AttemptLog
  }
}

$sw.Stop()
if ($result -is [System.Management.Automation.PSCustomObject] -or $result -is [hashtable]) {
  $result | Add-Member -NotePropertyName elapsed_ms -NotePropertyValue $sw.ElapsedMilliseconds -Force
  $result | Add-Member -NotePropertyName attempts_total -NotePropertyValue $script:AttemptLog.Count -Force
}

if ($script:NormalizedOnly -and $exitCode -eq 0) { $exitCode = 4 }

if ($Json) {
  # Serialize with an explicit depth and no type information. Using the
  # pipeline here would let a stray Write-Output from a helper leak into the
  # JSON stream and corrupt it.
  $json = ConvertTo-Json -InputObject $result -Depth 8
  [Console]::Out.Write($json)
} else {
  $result | Format-List | Out-String | ForEach-Object { [Console]::Out.Write($_) }
}

exit $exitCode
