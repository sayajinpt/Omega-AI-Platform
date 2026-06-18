import fs from "node:fs/promises";
import path from "node:path";
import { withLock } from "lifecycle-utils";
import { GgufReadOffset } from "../utils/GgufReadOffset.js";
import { defaultExtraAllocationSize } from "../consts.js";
import { GgufFileReader } from "./GgufFileReader.js";
import { transformPromisable } from "../../utils/transformPromisable.js";
/* omega-gguf-native-fix */
/* omega-gguf-buffer-window */
const MAX_GGUF_STRING_BYTES = 64 * 1024 * 1024;
const METADATA_KEY_SCAN_MARKERS = [
    "tokenizer.ggml.eos_token_id",
    "tokenizer.ggml.padding_token_id",
    "tokenizer.ggml.bos_token_id",
    "tokenizer.ggml.add_bos_token",
    "tokenizer.chat_template",
    "general.quantization_version",
    "general.file_type"
];
export class GgufFsFileReader extends GgufFileReader {
    filePath;
    _signal;
    /** File offset of this._buffer[0]. */
    _bufferFileOffset = 0;
    constructor({ filePath, signal }) {
        super();
        this.filePath = path.resolve(process.cwd(), filePath);
        this._signal = signal;
    }
    _filePosToBufferIndex(filePos) {
        return filePos - this._bufferFileOffset;
    }
    _syncBufferWindowForFilePos(filePos) {
        if (filePos < this._bufferFileOffset) {
            throw new Error(`gguf: cannot read file offset ${filePos} before buffered window`);
        }
        if (filePos > this._bufferFileOffset + this._buffer.length) {
            this._bufferFileOffset = filePos;
            this._buffer = Buffer.alloc(0);
        }
    }
    /**
     * Some GGUF writers (e.g. Qwen3) store very large tokenizer string arrays where the
     * per-element length-prefix stream stops matching before the declared element count.
     * Scan forward for the next well-formed metadata key so native load can continue.
     */
    async scanForNextMetadataKeyFieldOffset(fromOffset) {
        const maxScan = 16 * 1024 * 1024;
        const fd = await fs.open(this.filePath, "r");
        try {
            const buf = Buffer.alloc(maxScan);
            const { bytesRead } = await fd.read(buf, 0, maxScan, fromOffset);
            if (!bytesRead) {
                throw new Error("gguf: could not scan for next metadata key (EOF)");
            }
            const data = buf.subarray(0, bytesRead);
            let best = Infinity;
            for (const marker of METADATA_KEY_SCAN_MARKERS) {
                const needle = Buffer.from(marker, "utf8");
                let idx = 0;
                while (idx < data.length) {
                    const hit = data.indexOf(needle, idx);
                    if (hit < 0) {
                        break;
                    }
                    const keyStrPos = fromOffset + hit;
                    if (hit >= 8) {
                        const klen = Number(data.readBigUInt64LE(hit - 8));
                        if (klen === needle.length) {
                            const lenFieldPos = keyStrPos - 8;
                            if (lenFieldPos < best) {
                                best = lenFieldPos;
                            }
                        }
                    }
                    idx = hit + 1;
                }
            }
            if (!Number.isFinite(best)) {
                throw new Error("gguf: could not locate next metadata key after malformed tokenizer array");
            }
            return best;
        }
        finally {
            await fd.close();
        }
    }
    readByteRange(offset, length) {
        const readOffset = GgufReadOffset.resolveReadOffset(offset);
        const filePos = readOffset.offset;
        const endPos = filePos + length;
        this._syncBufferWindowForFilePos(filePos);
        if (endPos > this._bufferFileOffset + this._buffer.length) {
            return this._readToExpandBufferUpToOffset(endPos)
                .then(() => {
                const rel = this._filePosToBufferIndex(filePos);
                const res = this._buffer.subarray(rel, rel + length);
                readOffset.moveBy(length);
                return res;
            });
        }
        const rel = this._filePosToBufferIndex(filePos);
        const res = this._buffer.subarray(rel, rel + length);
        readOffset.moveBy(length);
        return res;
    }
    ensureHasByteRange(offset, length) {
        const readOffset = GgufReadOffset.resolveReadOffset(offset);
        const filePos = readOffset.offset;
        const endPos = filePos + length;
        this._syncBufferWindowForFilePos(filePos);
        if (endPos > this._bufferFileOffset + this._buffer.length) {
            return this._readToExpandBufferUpToOffset(endPos)
                .then(() => {
                if (endPos > this._bufferFileOffset + this._buffer.length) {
                    throw new Error("Expected buffer to be long enough for the requested byte range");
                }
            });
        }
        return undefined;
    }
    async _readToExpandBufferUpToOffset(endOffset, extraAllocationSize = defaultExtraAllocationSize) {
        if (endOffset > MAX_GGUF_STRING_BYTES * 4) {
            throw new Error(`gguf: refusing to buffer ${endOffset} bytes from gguf file`);
        }
        return await withLock([this, "modifyBuffer"], this._signal, async () => {
            const relEnd = endOffset - this._bufferFileOffset;
            if (relEnd <= this._buffer.length) {
                return;
            }
            const fileReadStart = this._bufferFileOffset + this._buffer.length;
            const fileReadLength = endOffset + extraAllocationSize - fileReadStart;
            const missingBytesBuffer = await this._readByteRange(fileReadStart, fileReadLength);
            this._addToBuffer(missingBytesBuffer);
        });
    }
    _withBufferRead(offset, length, reader) {
        if (length > MAX_GGUF_STRING_BYTES) {
            throw new Error(`gguf: read length ${length} exceeds safety cap`);
        }
        return transformPromisable(this.ensureHasByteRange(offset, length), () => {
            const readOffset = GgufReadOffset.resolveReadOffset(offset);
            const rel = this._filePosToBufferIndex(readOffset.offset);
            return transformPromisable(reader(rel), (res) => {
                readOffset.moveBy(length);
                return res;
            });
        });
    }
    async _readByteRange(start, length) {
        const fd = await fs.open(this.filePath, "r");
        try {
            if (this._signal?.aborted) {
                throw this._signal.reason;
            }
            const buffer = Buffer.alloc(length);
            await fd.read(buffer, 0, length, start);
            return buffer;
        }
        finally {
            await fd.close();
        }
    }
}
//# sourceMappingURL=GgufFsFileReader.js.map
