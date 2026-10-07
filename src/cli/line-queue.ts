/**
 * 行缓冲队列 —— 解决 readline 竞态：
 * 多行输入在同一 tick 到达时，question() 只能接住第一行，
 * 后续 line 事件会因没有等待者而丢失（粘贴多行/快速输入必现）。
 * 事件驱动 + 缓冲后，任何时机到达的行都不会丢。
 */
export class LineQueue {
  private readonly buffered: string[] = [];
  private readonly waiters: Array<(value: string | null) => void> = [];
  private closed = false;

  /** readline 'line' 事件 / 'close' 事件(null) 调用 */
  push(line: string | null): void {
    if (line === null) {
      this.closed = true;
      while (this.waiters.length > 0) {
 this.waiters.shift()!(null);
      }
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(line);
    } else {
      this.buffered.push(line);
    }
  }

  /** 取下一行；stdin 关闭后返回 null */
  next(): Promise<string | null> {
    if (this.buffered.length > 0) {
      return Promise.resolve(this.buffered.shift()!);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
