import { homedir } from 'node:os';
import { join } from 'node:path';

// AGYC_HOME 给测试用：每个测试一个临时目录，互不干扰。
export const HOME = process.env.AGYC_HOME || join(homedir(), '.claude-agy-bridge');
export const SOCK = join(HOME, 'sock');
export const SESSIONS_FILE = join(HOME, 'sessions.json');
export const LOG_DIR = join(HOME, 'logs');
export const DAEMON_LOG = join(HOME, 'daemon.log');
