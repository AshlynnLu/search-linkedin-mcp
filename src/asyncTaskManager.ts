import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ImportKeyCrawler } from './importKeyCrawler.js';

// 简单日志辅助函数
const logToFile = (message: string, isError = false) => {
  try {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync('async-task.log', logMessage);
  } catch {
    // 忽略日志错误
  }
};

// 任务类型
export enum TaskType {
  IMPORTKEY_BUYER = 'importkey_buyer',
  IMPORTKEY_SUPPLIER = 'importkey_supplier',
  IMPORTKEY_BOTH = 'importkey_both'
}

// 任务状态
export enum TaskStatus {
  PENDING = 'pending',       // 等待执行
  RUNNING = 'running',       // 正在执行
  COMPLETED = 'completed',   // 执行完成
  FAILED = 'failed',         // 执行失败
  TIMEOUT = 'timeout'        // 执行超时
}

// 任务数据接口
export interface TaskData {
  id: string;                           // 任务ID
  type: TaskType;                       // 任务类型
  status: TaskStatus;                   // 任务状态
  params: Record<string, any>;          // 任务参数
  createdAt: string;                    // 创建时间
  updatedAt: string;                    // 更新时间
  result?: any;                         // 任务结果
  error?: string;                       // 错误信息
  progress?: number;                    // 进度（0-100）
}

// 任务存储目录
const TASK_DIR = path.join(process.cwd(), 'tasks');

/**
 * 异步任务管理器
 * 负责创建、执行和管理长时间运行的任务
 */
export class AsyncTaskManager {
  private static instance: AsyncTaskManager;
  private runningTasks: Map<string, NodeJS.Timeout> = new Map();
  private initialized = false;

  private constructor() {
    // 私有构造函数，确保单例
    this.ensureTaskDir();
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): AsyncTaskManager {
    if (!AsyncTaskManager.instance) {
      AsyncTaskManager.instance = new AsyncTaskManager();
    }
    return AsyncTaskManager.instance;
  }

  /**
   * 初始化任务管理器，确保目录存在
   */
  private ensureTaskDir(): void {
    try {
      if (!fs.existsSync(TASK_DIR)) {
        fs.mkdirSync(TASK_DIR, { recursive: true });
      }
      this.initialized = true;
      logToFile('任务管理器初始化成功');
    } catch (error) {
      logToFile(`任务管理器初始化失败: ${error}`, true);
    }
  }

  /**
   * 创建新任务
   * @param type 任务类型
   * @param params 任务参数
   * @returns 任务ID
   */
  public createTask(type: TaskType, params: Record<string, any>): string {
    if (!this.initialized) {
      this.ensureTaskDir();
    }

    // 生成唯一任务ID
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // 创建任务数据
    const task: TaskData = {
      id,
      type,
      status: TaskStatus.PENDING,
      params,
      createdAt: now,
      updatedAt: now,
      progress: 0
    };

    // 保存任务数据
    this.saveTask(task);
    logToFile(`创建任务: ${id}, 类型: ${type}`);

    // 启动任务执行（异步）
    setTimeout(() => {
      this.runTask(id);
    }, 100);

    return id;
  }

  /**
   * 执行任务
   * @param taskId 任务ID
   */
  private async runTask(taskId: string): Promise<void> {
    // 读取任务数据
    const task = this.getTask(taskId);
    if (!task) {
      logToFile(`找不到任务: ${taskId}`, true);
      return;
    }

    // 更新任务状态
    task.status = TaskStatus.RUNNING;
    task.updatedAt = new Date().toISOString();
    this.saveTask(task);
    logToFile(`开始执行任务: ${taskId}`);

    // 设置超时监控（10分钟）
    const timeoutId = setTimeout(() => {
      this.handleTaskTimeout(taskId);
    }, 10 * 60 * 1000);
    this.runningTasks.set(taskId, timeoutId);

    try {
      // 根据任务类型执行不同操作
      switch (task.type) {
        case TaskType.IMPORTKEY_BUYER:
          await this.runImportKeyBuyerTask(task);
          break;
        case TaskType.IMPORTKEY_SUPPLIER:
          await this.runImportKeySupplierTask(task);
          break;
        case TaskType.IMPORTKEY_BOTH:
          await this.runImportKeyBothTask(task);
          break;
        default:
          throw new Error(`不支持的任务类型: ${task.type}`);
      }

      // 任务完成
      this.completeTask(taskId);
    } catch (error) {
      // 任务失败
      this.failTask(taskId, error instanceof Error ? error.message : String(error));
    } finally {
      // 清除超时监控
      if (this.runningTasks.has(taskId)) {
        clearTimeout(this.runningTasks.get(taskId)!);
        this.runningTasks.delete(taskId);
      }
    }
  }

  /**
   * 执行ImportKey买家数据任务
   */
  private async runImportKeyBuyerTask(task: TaskData): Promise<void> {
    const { companyName, email, password } = task.params;

    if (!companyName) {
      throw new Error('公司名称是必需的');
    }

    // 初始化爬虫
    ImportKeyCrawler.init(email, password);
    
    // 更新进度
    task.progress = 20;
    this.saveTask(task);

    // 爬取买家数据
    const buyerData = await ImportKeyCrawler.crawlBuyerData(companyName);
    
    // 更新进度
    task.progress = 90;
    this.saveTask(task);

    // 设置结果
    task.result = {
      company_name: companyName,
      buyer_data: buyerData,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 执行ImportKey供应商数据任务
   */
  private async runImportKeySupplierTask(task: TaskData): Promise<void> {
    const { companyName, email, password } = task.params;

    if (!companyName) {
      throw new Error('公司名称是必需的');
    }

    // 初始化爬虫
    ImportKeyCrawler.init(email, password);
    
    // 更新进度
    task.progress = 20;
    this.saveTask(task);

    // 爬取供应商数据
    const supplierData = await ImportKeyCrawler.crawlSupplierData(companyName);
    
    // 更新进度
    task.progress = 90;
    this.saveTask(task);

    // 设置结果
    task.result = {
      company_name: companyName,
      supplier_data: supplierData,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 执行ImportKey买家和供应商数据任务
   */
  private async runImportKeyBothTask(task: TaskData): Promise<void> {
    const { companyName, email, password } = task.params;

    if (!companyName) {
      throw new Error('公司名称是必需的');
    }

    // 初始化爬虫
    ImportKeyCrawler.init(email, password);
    
    // 更新进度
    task.progress = 20;
    this.saveTask(task);

    // 修改为顺序执行，而不是并行执行
    // 先爬取供应商数据
    logToFile(`执行任务: 爬取供应商数据 - ${companyName}`);
    const supplierData = await ImportKeyCrawler.crawlSupplierData(companyName);
    
    // 中间进度更新
    task.progress = 50;
    this.saveTask(task);
    
    // 然后爬取买家数据，保持会话状态
    logToFile(`执行任务: 爬取买家数据 - ${companyName}`);
    const buyerData = await ImportKeyCrawler.crawlBuyerData(companyName);
    
    // 更新进度
    task.progress = 90;
    this.saveTask(task);

    // 设置结果
    task.result = {
      company_name: companyName,
      buyer_data: buyerData,
      supplier_data: supplierData,
      timestamp: new Date().toISOString()
    };
    
    // 立即保存结果数据
    logToFile(`保存任务结果数据: ${task.id}`);
    this.saveTask(task);
  }

  /**
   * 完成任务
   */
  private completeTask(taskId: string): void {
    // 获取最新的任务状态，包括可能存在的结果数据
    const task = this.getTask(taskId);
    if (!task) return;

    // 保存当前的 result 字段（如果存在）
    const originalResult = task.result;

    // 更新任务状态
    task.status = TaskStatus.COMPLETED;
    task.updatedAt = new Date().toISOString();
    task.progress = 100;
    
    // 确保 result 字段被保留
    if (!task.result && originalResult) {
      task.result = originalResult;
      logToFile(`恢复任务结果数据: ${taskId}`);
    }
    
    // 保存任务，包括结果数据
    this.saveTask(task);
    logToFile(`任务完成: ${taskId}`);
  }

  /**
   * 标记任务失败
   */
  private failTask(taskId: string, errorMessage: string): void {
    const task = this.getTask(taskId);
    if (!task) return;

    task.status = TaskStatus.FAILED;
    task.updatedAt = new Date().toISOString();
    task.error = errorMessage;
    this.saveTask(task);
    logToFile(`任务失败: ${taskId}, 错误: ${errorMessage}`, true);
  }

  /**
   * 处理任务超时
   */
  private handleTaskTimeout(taskId: string): void {
    const task = this.getTask(taskId);
    if (!task) return;

    task.status = TaskStatus.TIMEOUT;
    task.updatedAt = new Date().toISOString();
    task.error = '任务执行超时';
    this.saveTask(task);
    logToFile(`任务超时: ${taskId}`, true);

    // 删除运行中的任务记录
    this.runningTasks.delete(taskId);
  }

  /**
   * 获取任务状态
   * @param taskId 任务ID
   * @returns 任务数据
   */
  public getTaskStatus(taskId: string): TaskData | null {
    return this.getTask(taskId);
  }

  /**
   * 从文件系统读取任务数据
   */
  private getTask(taskId: string): TaskData | null {
    try {
      const taskPath = path.join(TASK_DIR, `${taskId}.json`);
      if (!fs.existsSync(taskPath)) {
        return null;
      }
      const taskJson = fs.readFileSync(taskPath, 'utf-8');
      return JSON.parse(taskJson) as TaskData;
    } catch (error) {
      logToFile(`读取任务数据失败: ${taskId}, ${error}`, true);
      return null;
    }
  }

  /**
   * 将任务数据保存到文件系统
   */
  private saveTask(task: TaskData): void {
    try {
      // 检查结果数据大小，如果太大，可能需要截断或分离保存
      if (task.result) {
        const jsonSize = JSON.stringify(task.result).length;
        logToFile(`保存任务数据: ${task.id}, 结果数据大小: ${jsonSize} 字节`);
        
        // 如果结果数据超过1MB，将额外保存一个结果文件
        if (jsonSize > 1024 * 1024) {
          const resultPath = path.join(TASK_DIR, `${task.id}_result.json`);
          fs.writeFileSync(resultPath, JSON.stringify(task.result, null, 2), 'utf-8');
          logToFile(`结果数据过大，已单独保存到: ${resultPath}`);
          
          // 在主任务文件中保存结果位置引用
          task.result = {
            reference: `${task.id}_result.json`,
            timestamp: new Date().toISOString()
          };
        }
      }
      
      const taskPath = path.join(TASK_DIR, `${task.id}.json`);
      fs.writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
      logToFile(`任务数据已保存: ${task.id}`);
    } catch (error) {
      logToFile(`保存任务数据失败: ${task.id}, ${error}`, true);
    }
  }

  /**
   * 清理过期任务（保留最近7天的任务）
   */
  public cleanupTasks(): void {
    try {
      const files = fs.readdirSync(TASK_DIR);
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const taskPath = path.join(TASK_DIR, file);
        try {
          const stats = fs.statSync(taskPath);
          if (stats.mtime < sevenDaysAgo) {
            fs.unlinkSync(taskPath);
            logToFile(`清理过期任务: ${file}`);
          }
        } catch {
          // 忽略单个文件的错误
        }
      }
    } catch (error) {
      logToFile(`清理过期任务失败: ${error}`, true);
    }
  }
} 