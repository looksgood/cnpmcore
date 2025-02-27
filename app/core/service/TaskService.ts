import {
  AccessLevel,
  ContextProto,
  Inject,
} from '@eggjs/tegg';
import { NFSAdapter } from '../../common/adapter/NFSAdapter';
import { TaskState, TaskType } from '../../common/enum/Task';
import { AbstractService } from '../../common/AbstractService';
import { TaskRepository } from '../../repository/TaskRepository';
import { Task } from '../entity/Task';
import { QueueAdapter } from '../../common/adapter/QueueAdapter';

@ContextProto({
  accessLevel: AccessLevel.PUBLIC,
})
export class TaskService extends AbstractService {
  @Inject()
  private readonly taskRepository: TaskRepository;
  @Inject()
  private readonly nfsAdapter: NFSAdapter;
  @Inject()
  private readonly queueAdapter: QueueAdapter;

  public async createTask(task: Task, addTaskQueueOnExists: boolean) {
    const existsTask = await this.taskRepository.findTaskByTargetName(task.targetName, task.type);
    if (existsTask) {
      if (addTaskQueueOnExists && existsTask.state === TaskState.Waiting) {
        // make sure waiting task in queue
        await this.queueAdapter.push<string>(task.type, existsTask.taskId);
      }
      return existsTask;
    }
    await this.taskRepository.saveTask(task);
    const queueSize = await this.queueAdapter.push<string>(task.type, task.taskId);
    this.logger.info('[TaskService.createTask:new] taskType: %s, targetName: %s, taskId: %s, queue size: %s',
      task.type, task.targetName, task.taskId, queueSize);
    return task;
  }

  public async retryTask(task: Task, appendLog?: string) {
    if (appendLog) {
      await this.appendLogToNFS(task, appendLog);
    }
    task.state = TaskState.Waiting;
    // make sure updatedAt changed
    task.updatedAt = new Date();
    await this.taskRepository.saveTask(task);
    const queueSize = await this.queueAdapter.push<string>(task.type, task.taskId);
    this.logger.info('[TaskService.retryTask:save] taskType: %s, targetName: %s, taskId: %s, queue size: %s',
      task.type, task.targetName, task.taskId, queueSize);
  }

  public async findTask(taskId: string) {
    return await this.taskRepository.findTask(taskId);
  }

  public async findTaskLog(task: Task) {
    return await this.nfsAdapter.getDownloadUrlOrStream(task.logPath);
  }

  public async findExecuteTask(taskType: TaskType) {
    const taskId = await this.queueAdapter.pop<string>(taskType);
    if (taskId) {
      const task = await this.taskRepository.findTask(taskId);
      if (task) {
        task.setExecuteWorker();
        task.state = TaskState.Processing;
        task.attempts += 1;
        await this.taskRepository.saveTask(task);
        return task;
      }
    }
    return null;
  }

  public async retryExecuteTimeoutTasks() {
    // try processing timeout tasks in 10 mins
    const tasks = await this.taskRepository.findTimeoutTasks(TaskState.Processing, 60000 * 10);
    for (const task of tasks) {
      // ignore ChangesStream task, it won't timeout
      if (task.attempts >= 3 && task.type !== TaskType.ChangesStream) {
        await this.finishTask(task, TaskState.Timeout);
        this.logger.warn(
          '[TaskService.retryExecuteTimeoutTasks:timeout] taskType: %s, targetName: %s, taskId: %s, attempts %s set to fail',
          task.type, task.targetName, task.taskId, task.attempts);
        continue;
      }
      if (task.attempts >= 1) {
        // reset logPath
        task.resetLogPath();
      }
      await this.retryTask(task);
      this.logger.warn(
        '[TaskService.retryExecuteTimeoutTasks:retry] taskType: %s, targetName: %s, taskId: %s, attempts %s will retry again',
        task.type, task.targetName, task.taskId, task.attempts);
    }
    // try waiting timeout tasks in 30 mins
    const waitingTasks = await this.taskRepository.findTimeoutTasks(TaskState.Waiting, 60000 * 30);
    for (const task of waitingTasks) {
      await this.retryTask(task);
      this.logger.warn(
        '[TaskService.retryExecuteTimeoutTasks:retryWaiting] taskType: %s, targetName: %s, taskId: %s waiting too long',
        task.type, task.targetName, task.taskId);
    }
    return {
      processing: tasks.length,
      waiting: waitingTasks.length,
    };
  }

  public async appendTaskLog(task: Task, appendLog: string) {
    await this.appendLogToNFS(task, appendLog);
    task.updatedAt = new Date();
    await this.taskRepository.saveTask(task);
  }

  public async finishTask(task: Task, taskState: TaskState, appendLog?: string) {
    if (appendLog) {
      await this.appendLogToNFS(task, appendLog);
    }
    task.state = taskState;
    await this.taskRepository.saveTaskToHistory(task);
  }

  private async appendLogToNFS(task: Task, appendLog: string) {
    try {
      const nextPosition = await this.nfsAdapter.appendBytes(
        task.logPath,
        Buffer.from(appendLog + '\n'),
        task.logStorePosition,
        {
          'Content-Type': 'text/plain; charset=utf-8',
        },
      );
      if (nextPosition) {
        task.logStorePosition = nextPosition;
      }
    } catch (err: any) {
      // [PositionNotEqualToLengthError]: Position is not equal to file length, status: 409
      // [ObjectNotAppendableError]: The object is not appendable
      if (err.code === 'PositionNotEqualToLength' || err.code === 'ObjectNotAppendable') {
        // override exists log file
        await this.nfsAdapter.uploadBytes(
          task.logPath,
          Buffer.from(appendLog + '\n'),
        );
        return;
      }
      throw err;
    }
  }
}
