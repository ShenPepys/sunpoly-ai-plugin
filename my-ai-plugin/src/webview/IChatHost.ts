/**
 * 聊天宿主接口
 *
 * 定义 Webview 容器（侧边栏 / 编辑器 Tab）必须提供的能力，
 * 使 ChatEngine 不依赖具体的 VS Code Webview 类型，
 * 从而可以被侧边栏和 Tab 面板共享。
 */
import * as vscode from 'vscode';
import type { ExtensionMessage } from './messageTypes';

export interface IChatHost {
  /**
   * 向前端 Webview 发送消息
   * 宿主负责将消息投递到自己持有的 Webview 实例
   */
  postMessage(message: ExtensionMessage): void;

  /**
   * 获取当前 Webview 实例（可能尚未初始化，返回 undefined）
   * ChatEngine 在构建 HTML 时需要 Webview 来生成 CSP nonce 和资源 URI
   */
  getWebview(): vscode.Webview | undefined;

  /**
   * 获取插件根目录 URI
   * 用于定位 media/ 和 dist/media/ 下的前端资源
   */
  getExtensionUri(): vscode.Uri;

  /**
   * 获取 globalState 持久化存储
   * ChatEngine 通过它读写会话数据
   */
  getGlobalState(): vscode.Memento;

  /**
   * 使面板可见（侧边栏展开 / Tab 聚焦）
   */
  reveal(): void;

  /**
   * 更新宿主标题（可选）
   * Tab 宿主可用此更新编辑器 Tab 标签文字，侧边栏宿主可忽略
   */
  setTitle?(title: string): void;
}
