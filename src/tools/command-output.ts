import { StringDecoder } from "node:string_decoder";

/** 持续消费管道，只在内存保留首尾；分块解码避免中文跨 chunk 时损坏。 */
export class CommandOutputBuffer {
  private readonly decoder = new StringDecoder("utf8");
  private head = "";
  private tail = "";
  private count = 0;
  private headComplete = false;
  private readonly headLimit: number;
  private readonly tailLimit: number;

  constructor(limit: number) {
    this.headLimit = Math.ceil(limit / 2);
    this.tailLimit = Math.floor(limit / 2);
  }

  get retainedChars(): number { return this.head.length + this.tail.length; }

  append(chunk: Buffer): void { this.keep(this.decoder.write(chunk)); }

  finish(): string {
    this.keep(this.decoder.end());
    const missing = this.count - this.retainedChars;
    return missing <= 0 ? this.head + this.tail : `${this.head}\n...(输出已截断，中间省略 ${missing} 字符)\n${this.tail}`;
  }

  private keep(text: string): void {
    this.count += text.length;
    let take = this.headComplete ? 0 : Math.min(this.headLimit - this.head.length, text.length);
    if (take > 0 && /[\uD800-\uDBFF]/.test(text[take - 1]!)) take--;
    if (take < text.length || this.head.length + take >= this.headLimit) this.headComplete = true;
    this.head += text.slice(0, take);
    const tail = this.tail + text.slice(take);
    let from = Math.max(0, tail.length - this.tailLimit);
    if (/[\uDC00-\uDFFF]/.test(tail[from] ?? "")) from++;
    this.tail = tail.slice(from);
  }
}
