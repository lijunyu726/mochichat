import { homedir } from 'node:os';
import { join } from 'node:path';

export const MOCHI_HOME = process.env.MOCHI_HOME || join(homedir(), '.mochichat');
export const MOCHI_PORT = Number(process.env.MOCHI_PORT || 4517);
// 没指定工作目录的团队放在这里，每个团队一个文件夹。
export const WORKSPACE = process.env.MOCHI_WORKSPACE || join(homedir(), 'mochichat');
export const TOKEN_FILE = join(MOCHI_HOME, 'token');
export const HUB_FILE = join(MOCHI_HOME, 'hub.json');
