import type { TaskRecord } from './types.js';

function taskMap(tasks: readonly TaskRecord[]): Map<string, TaskRecord> {
  const byId = new Map<string, TaskRecord>();
  for (const task of tasks) {
    if (byId.has(task.taskId)) throw new Error(`Duplicate task id: ${task.taskId}`);
    byId.set(task.taskId, task);
  }
  return byId;
}

export function validateTaskGraph(tasks: readonly TaskRecord[]): void {
  const byId = taskMap(tasks);

  for (const task of tasks) {
    for (const dependencyId of task.dependencies) {
      if (dependencyId === task.taskId) {
        throw new Error(`Task graph cycle: ${task.taskId} depends on itself`);
      }
      if (!byId.has(dependencyId)) {
        throw new Error(`Task ${task.taskId} has missing dependency: ${dependencyId}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) throw new Error(`Task graph cycle detected at ${taskId}`);

    visiting.add(taskId);
    const task = byId.get(taskId);
    if (!task) throw new Error(`Task graph lost task: ${taskId}`);
    for (const dependencyId of task.dependencies) visit(dependencyId);
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const task of tasks) visit(task.taskId);
}

export function readyTaskIds(tasks: readonly TaskRecord[]): string[] {
  validateTaskGraph(tasks);
  const byId = taskMap(tasks);

  return tasks
    .filter((task) => {
      if (task.state === 'READY') return true;
      if (task.state !== 'PLANNED') return false;
      return task.dependencies.every((dependencyId) => byId.get(dependencyId)?.state === 'VERIFIED');
    })
    .map((task) => task.taskId);
}
