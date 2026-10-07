/**
 * 按 key（session id）调度的任务队列：
 * - 不同 key 的任务并发执行（互不阻塞、互不影响）
 * - 相同 key 的任务串行合并执行（后到的排在链尾，保证会话历史不被并发写坏）
 */
export class SessionScheduler {
  private readonly chains = new Map<string, Promise<unknown>>();

  submit<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    // 无论前一个任务成败，后续任务都继续执行（链不断）
    const result = previous.then(task, task);

    // 链尾自清理，防止 Map 随会话数无限增长
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    });

    return result;
  }

  hasPending(key: string): boolean {
    return this.chains.has(key);
  }
}
