import * as fs from 'fs';
import { AsyncTaskManager, TaskType, TaskStatus } from './asyncTaskManager.js';
import { getParamValue, ENV_NAMES, getAuthValue } from './config/env.js';
import { IMPORTKEY_ENV_NAMES } from './importKeyTool.js';

// 简单日志辅助函数
const logToFile = (message: string, isError = false) => {
  try {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync('async-importkey.log', logMessage);
  } catch {
    // 忽略日志错误
  }
};

/**
 * 异步ImportKey工具类
 * 提供创建海关数据任务和查询任务状态的功能
 */
export class AsyncImportKeyTools {
  private static taskManager = AsyncTaskManager.getInstance();

  /**
   * 创建新的ImportKey数据任务
   * @param companyName 公司名称
   * @param type 任务类型：买家数据/供应商数据/全部数据
   * @param request MCP请求对象
   * @returns 任务信息
   */
  public static async createCustomsDataTask(
    companyName: string,
    type: 'buyer' | 'supplier' | 'both',
    request?: any
  ): Promise<{
    task_id: string;
    company_name: string;
    type: string;
    status: string;
    created_at: string;
  }> {
    // 获取ImportKey登录凭证
    const emailFromRequest = request ? getAuthValue(request, IMPORTKEY_ENV_NAMES.EMAIL) : null;
    const passwordFromRequest = request ? getAuthValue(request, IMPORTKEY_ENV_NAMES.PASSWORD) : null;
    
    const email = emailFromRequest || getParamValue(IMPORTKEY_ENV_NAMES.EMAIL);
    const password = passwordFromRequest || getParamValue(IMPORTKEY_ENV_NAMES.PASSWORD);
    
    if (!email || !password) {
      throw new Error('ImportKey登录凭证未设置，请配置IMPORTKEY_EMAIL和IMPORTKEY_PASSWORD环境变量');
    }
    
    // 确定任务类型
    let taskType: TaskType;
    switch (type) {
      case 'buyer':
        taskType = TaskType.IMPORTKEY_BUYER;
        break;
      case 'supplier':
        taskType = TaskType.IMPORTKEY_SUPPLIER;
        break;
      case 'both':
      default:
        taskType = TaskType.IMPORTKEY_BOTH;
        break;
    }
    
    // 创建任务参数
    const taskParams = {
      companyName,
      email,
      password
    };
    
    // 创建异步任务
    logToFile(`创建公司"${companyName}"的${type}数据任务`);
    const taskId = this.taskManager.createTask(taskType, taskParams);
    
    // 获取任务状态
    const task = this.taskManager.getTaskStatus(taskId);
    if (!task) {
      throw new Error('任务创建失败');
    }
    
    // 返回任务信息
    return {
      task_id: task.id,
      company_name: companyName,
      type: this.getTaskTypeLabel(task.type),
      status: task.status,
      created_at: task.createdAt
    };
  }
  
  /**
   * 获取任务类型的显示标签
   */
  private static getTaskTypeLabel(type: TaskType): string {
    switch (type) {
      case TaskType.IMPORTKEY_BUYER:
        return '买家数据';
      case TaskType.IMPORTKEY_SUPPLIER:
        return '供应商数据';
      case TaskType.IMPORTKEY_BOTH:
        return '买家和供应商数据';
      default:
        return '未知类型';
    }
  }

  /**
   * 获取任务状态
   * @param taskId 任务ID
   * @returns 任务状态信息
   */
  public static async getTaskStatus(taskId: string): Promise<any> {
    const task = this.taskManager.getTaskStatus(taskId);
    
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }
    
    // 构建任务状态响应
    const response: any = {
      task_id: task.id,
      status: task.status,
      type: this.getTaskTypeLabel(task.type),
      progress: task.progress || 0,
      created_at: task.createdAt,
      updated_at: task.updatedAt
    };
    
    // 根据任务状态添加不同的信息
    switch (task.status) {
      case TaskStatus.COMPLETED:
        // 任务完成，返回结果
        response.result = task.result;
        break;
      case TaskStatus.FAILED:
        // 任务失败，返回错误信息
        response.error = task.error || '未知错误';
        break;
      case TaskStatus.TIMEOUT:
        // 任务超时
        response.error = '任务执行超时';
        break;
      case TaskStatus.PENDING:
      case TaskStatus.RUNNING:
        // 任务运行中或等待中，返回预计剩余时间
        const elapsedTime = new Date().getTime() - new Date(task.createdAt).getTime();
        const totalEstimatedTime = task.type === TaskType.IMPORTKEY_BOTH ? 300000 : 180000; // 5分钟或3分钟
        const remainingTimeMs = Math.max(0, totalEstimatedTime - elapsedTime);
        response.estimated_remaining_seconds = Math.ceil(remainingTimeMs / 1000);
        break;
    }
    
    return response;
  }

  /**
   * 清理过期任务
   */
  public static cleanupTasks(): void {
    this.taskManager.cleanupTasks();
  }
} 