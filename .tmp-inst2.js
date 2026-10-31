    console.log('');
    // 存活必须和安装状态并列：装好了但没在跑，是最容易忽略的情况（DF-023）。
    try {
      const { state } = loadState(stateDir, { logger: null }); // eslint-disable-line
    } catch { /* 下面统一处理 */ }
