/**
 * 聊天 Tab 管理器
 *
 * 管理所有在编辑器区域打开的聊天 Tab 实例，
 * 负责创建、查找、关闭和全量销毁。
 */
import * as vscode from 'vscode';
import { info } from '../logger';
import { ChatTabPanel } from './ChatTabPanel';

export class ChatTabManager {

  /** 所有打开的 Tab 实例，key 为 tabId */
  private readonly tabs = new Map<string, ChatTabPanel>();

  /** 插件上下文引用 */
  private readonly context: vscode.ExtensionContext;

  /** 模型切换回调，新建的 Tab 会继承此回调 */
  public onModelSwitch?: (modelName: string) => void;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * 创建并打开一个新的聊天 Tab
   * @returns 新创建的 ChatTabPanel 实例
   */
  public createTab(): ChatTabPanel {
    const tab = new ChatTabPanel(this.context);

    // Tab 关闭时自动从管理器中移除
    tab.onDispose = () => {
      this.tabs.delete(tab.tabId);
      info(`Tab 管理器：移除已关闭的 Tab ${tab.tabId}，剩余 ${this.tabs.size} 个`);
    };

    // 继承全局模型切换回调
    if (this.onModelSwitch) {
      tab.onModelSwitch = this.onModelSwitch;
    }

    this.tabs.set(tab.tabId, tab);
    info(`Tab 管理器：新建 Tab ${tab.tabId}，当前共 ${this.tabs.size} 个`);

    return tab;
  }

  /**
   * 获取或创建聊天 Tab（主入口）
   * 优先返回活跃 Tab → 其次最近一个 Tab → 都没有则新建
   * 所有命令路由都通过此方法获取目标 Tab
   */
  public getOrCreateTab(): ChatTabPanel {
    const activeTab = this.getActiveTab();
    if (activeTab) {
      return activeTab;
    }

    // 没有活跃 Tab 时，返回最后一个打开的 Tab
    const lastTab = [...this.tabs.values()].pop();
    if (lastTab) {
      return lastTab;
    }

    // 完全没有 Tab，新建一个
    return this.createTab();
  }

  /**
   * 获取当前处于活跃状态的 Tab（如果有的话）
   * 活跃状态指 Tab 在编辑器中处于焦点
   */
  public getActiveTab(): ChatTabPanel | undefined {
    for (const tab of this.tabs.values()) {
      if (tab.isActive) {
        return tab;
      }
    }
    return undefined;
  }

  /** 获取指定 ID 的 Tab */
  public getTab(tabId: string): ChatTabPanel | undefined {
    return this.tabs.get(tabId);
  }

  /** 当前打开的 Tab 数量 */
  public get size(): number {
    return this.tabs.size;
  }

  /** 关闭指定 Tab */
  public closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.dispose();
      // onDispose 回调会自动从 map 中移除
    }
  }

  /** 关闭所有 Tab（插件停用时调用） */
  public dispose(): void {
    // 复制 keys 数组避免在迭代中修改 Map
    const tabIds = [...this.tabs.keys()];
    for (const tabId of tabIds) {
      this.closeTab(tabId);
    }
    info('Tab 管理器：已关闭所有 Tab');
  }
}
