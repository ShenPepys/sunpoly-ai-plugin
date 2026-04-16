/**
 * vscode 模块最小 mock
 *
 * 在纯 Node 测试环境中预加载此脚本，避免依赖 vscode 运行时的模块报 MODULE_NOT_FOUND。
 * 用法：node --require ./scripts/vscode-mock.cjs ...
 */

const Module = require('module');
const originalResolveFilename = Module._resolveFilename;

// 拦截 vscode 模块解析，返回虚拟路径
Module._resolveFilename = function (request, parentModule, isMain, options) {
  if (request === 'vscode') {
    return request;
  }
  return originalResolveFilename.call(this, request, parentModule, isMain, options);
};

// 提供最小 vscode mock 对象
Module._load = function (originalLoad) {
  return function (request, ...args) {
    if (request === 'vscode') {
      return {
        Memento: class { get() { return undefined; } update() { return Promise.resolve(); } },
        Disposable: class { dispose() {} },
        EventEmitter: class { fire() {} event() { return { dispose() {} }; } },
        Uri: { parse: () => ({}) , joinPath: () => ({}) },
        window: { showWarningMessage: () => {}, showInformationMessage: () => {} },
        workspace: { getConfiguration: () => ({ get: () => undefined }) },
      };
    }
    return originalLoad.call(this, request, ...args);
  };
}(Module._load);
