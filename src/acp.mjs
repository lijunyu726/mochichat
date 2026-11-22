// 最小的 ACP 客户端：通过子进程的标准输入输出收发逐行 JSON-RPC。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class AcpClient {
  #nextId = 1;
  #pending = new Map();
  #stderrTail = '';
  #dead = false;
  #child = null;

  // o: { bin, args, cwd, env, onNotify(method, params), onRequest(method, params, respond), onExit(reason) }
  constructor(o) { this.o = o; }

  get pid() { return this.#child?.pid; }
  get dead() { return this.#dead; }

  start() {
    const { bin, args, cwd, env } = this.o;
    const child = (this.#child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }));
    child.stderr.on('data', (d) => { this.#stderrTail = (this.#stderrTail + d).slice(-1500); });
    child.stdin.on('error', () => {});
    child.on('error', (e) => this.#down(`无法启动 ${bin}：${e.message}`));
    child.on('exit', (code, signal) => this.#down(`agy 进程已退出（code=${code} signal=${signal}）`));
    createInterface({ input: child.stdout }).on('line', (l) => this.#line(l));
  }

  #down(reason) {
    if (this.#dead) return;
    this.#dead = true;
    const tail = this.#stderrTail.trim();
    const err = new Error(tail ? `${reason}\n${tail.slice(-600)}` : reason);
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
    this.o.onExit?.(reason);
  }

  #send(obj) { this.#child.stdin.write(JSON.stringify(obj) + '\n'); }

  #line(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && !m.method) {
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message ?? JSON.stringify(m.error)}`));
      else p.resolve(m.result);
    } else if (m.method && m.id !== undefined) {
      const respond = (result, error) => this.#send(error ? { jsonrpc: '2.0', id: m.id, error } : { jsonrpc: '2.0', id: m.id, result });
      this.o.onRequest?.(m.method, m.params, respond);
    } else if (m.method) {
      this.o.onNotify?.(m.method, m.params);
    }
  }

  call(method, params) {
    if (this.#dead) return Promise.reject(new Error('agy 进程不在运行'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { if (!this.#dead) this.#send({ jsonrpc: '2.0', method, params }); }

  kill() { this.#child?.kill(); }
}
