import { homedir } from 'node:os';
import { join } from 'node:path';

export const PEER_HOME = process.env.PEER_HOME || join(homedir(), '.peer');
export const PEER_PORT = Number(process.env.PEER_PORT || 4517);
export const TOKEN_FILE = join(PEER_HOME, 'token');
export const HUB_FILE = join(PEER_HOME, 'hub.json');
