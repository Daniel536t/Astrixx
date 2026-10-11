import { Buffer } from 'buffer';

type BufferGlobal = typeof globalThis & { Buffer: typeof Buffer };

(globalThis as BufferGlobal).Buffer = Buffer;
