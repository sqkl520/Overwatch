  sessions() {
    const scanned = this.data?.sessions ?? [];
    const live = this.data?.live ?? [];
    // **把「只有 live、没有 transcript」的会话补进来。**
    //
    // 2026-11-01 实测：一个 status:"waiting" 的会话在 scan-sessions 的人读输出里
    // 正确显示 `← 正在等你（input needed）`，但 TUI 里完全看不到——
    // 因为 TUI 只读 data.sessions（transcript 扫描结果），而这个会话没有 transcript。
    //
    // 更要命的是：**正在等你这件事本身，恰恰常常发生在会话还没写多少 transcript 的时候。**
    // 主界面看不见它，等于这个功能的主入口是瞎的。
    //
    // 只补 WAITING / BLOCKED / FAILED：其余状态没有 transcript 就没有任何可展示的信息
    // （calls / novelty 全为空），补进来只是噪音。
    const have = new Set(scanned.map((s) => s.sessionId));
    const extra = [];
    for (const l of live) {
      if (!l || !l.sessionId || have.has(l.sessionId)) continue;
      if (!['WAITING', 'BLOCKED', 'FAILED'].includes(l.statusToState?.(l) ?? statusToState(l))) continue;
      extra.push(liveToRow(l, this.now()));
    }
    return extra.length ? [...scanned, ...extra] : scanned;
  }
