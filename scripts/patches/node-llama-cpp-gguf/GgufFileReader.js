import { GgufReadOffset } from "../utils/GgufReadOffset.js";
import { transformPromisable } from "../../utils/transformPromisable.js";
/* omega-gguf-native-fix */
const MAX_GGUF_STRING_BYTES = 64 * 1024 * 1024;
export const valueTypeToBytesToRead = {
    uint8: 1,
    uint16: 2,
    uint32: 4,
    uint64: 8,
    int8: 1,
    int16: 2,
    int32: 4,
    int64: 8,
    float32: 4,
    float64: 8,
    bool: 1
};
export class GgufFileReader {
    _buffer = Buffer.alloc(0);
    readUint8(offset) {
        return this._withBufferRead(offset, valueTypeToBytesToRead.uint8, (resolvedOffset) => {
            return this._buffer.readUInt8(resolvedOffset);
        });
    }
    readUint16(offset) {
        return this._withBufferRead(offset, valueTypeToBytesToRead.uint16, (resolvedOffset) => {
            return this._buffer.readUInt16LE(resolvedOffset);
        });
    }
    readUint32(offset) {
        return this._withBufferRead(offset, valueTypeToBytesToRead.uint32, (resolvedOffset) => {
            return this._buffer.readUInt32LE(resolvedOffset);
        });
    }
    readUint64(offset) {
        return this._withBufferRead(offset, valueTypeToBytesToRead.uint64, (resolvedOffset) => {
            return this._buffer.readBigUInt64LE(resolvedOffset);
        });
    }
    readInt8(offset) {
        return this._withBufferRead(offset, valueTypeToBytesToRead.int8, (resolvedOffset) => {
            return this._buffer.readInt8(resolvedOffset);
        });
    }
    readInt16(offset) {
        return this._withBufferRead(offset, valueTypeToBytesToRead.int16, (resolvedOffset) => {
            return this._buffer.readInt16LE(resolvedOffset);
        });
    }
    readInt32(offset) {
        return this._withBufferRead(offset, valueTypeToBytesToRead.int32, (resolvedOffset) => {
            return this._buffer.readInt32LE(resolvedOffset);
        });
    }
    readInt64(offset) {
        return this._withBufferRead(offset, valueTypeToBytesToRead.int64, (resolvedOffset) => {
            return this._buffer.readBigInt64LE(resolvedOffset);
        });
    }
    readFloat32(offset) {
        return this._withBufferRead(offset, valueTypeToBytesToRead.float32, (resolvedOffset) => {
            return this._buffer.readFloatLE(resolvedOffset);
        });
    }
    readFloat64(offset) {
        return this._withBufferRead(offset, valueTypeToBytesToRead.float64, (resolvedOffset) => {
            return this._buffer.readDoubleLE(resolvedOffset);
        });
    }
    readBool(offset) {
        return this._withBufferRead(offset, valueTypeToBytesToRead.uint8, (resolvedOffset) => {
            return this._buffer.readUInt8(resolvedOffset) === 1;
        });
    }
    readString(offset) {
        const readOffset = GgufReadOffset.resolveReadOffset(offset);
        return transformPromisable(this.readUint64(readOffset), (length) => {
            return this.readStringWithLength(readOffset, Number(length));
        });
    }
    readStringWithLength(offset, length) {
        const readLength = valueTypeToBytesToRead.uint8 * length;
        return this._withBufferRead(offset, readLength, (resolvedOffset) => {
            return this._buffer.toString("utf8", resolvedOffset, Math.min(resolvedOffset + readLength, this._buffer.length));
        });
    }
    _addToBuffer(buffer) {
        const newBuffer = Buffer.alloc(this._buffer.byteLength + buffer.byteLength);
        this._buffer.copy(newBuffer);
        buffer.copy(newBuffer, this._buffer.byteLength);
        this._buffer = newBuffer;
    }
    async skipByteRange(offset, length) {
        const readOffset = GgufReadOffset.resolveReadOffset(offset);
        const n = Number(length);
        if (n < 0 || n > MAX_GGUF_STRING_BYTES) {
            throw new Error(`gguf: implausible skip length ${n}`);
        }
        return transformPromisable(this.ensureHasByteRange(offset, n), () => {
            readOffset.moveBy(n);
        });
    }
    _withBufferRead(offset, length, reader) {
        if (length > MAX_GGUF_STRING_BYTES) {
            throw new Error(`gguf: read length ${length} exceeds safety cap`);
        }
        return transformPromisable(this.ensureHasByteRange(offset, length), () => {
            const resolvedOffset = GgufReadOffset.resolveReadOffset(offset);
            return transformPromisable(reader(resolvedOffset.offset), (res) => {
                resolvedOffset.moveBy(Math.min(length, this._buffer.length - resolvedOffset.offset));
                return res;
            });
        });
    }
    static castNumberIfSafe(value) {
        if (value > Number.MAX_SAFE_INTEGER)
            return value;
        return Number(value);
    }
}
//# sourceMappingURL=GgufFileReader.js.map