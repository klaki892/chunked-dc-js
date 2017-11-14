/**
 * Copyright (C) 2017 Threema GmbH / SaltyRTC Contributors
 *
 * Licensed under the Apache License, Version 2.0, <see LICENSE-APACHE file>
 * or the MIT license <see LICENSE-MIT file>, at your option. This file may not be
 * copied, modified, or distributed except according to those terms.
 */
/// <reference path="../chunked-dc.d.ts" />

import {Common} from "./common";

/**
 * Helper class to access chunk information.
 */
export abstract class Chunk {
    private _length: number;
    private _endOfMessage: boolean;
    private _id: number;
    private _serial: number;
    private _data: any;
    private _context: any;

    /**
     * Parse the buffer.
     */
    constructor(buf: any, length: number, context?: any) {
        if (length < Common.HEADER_LENGTH) {
            throw new Error('Invalid chunk: Too short');
        }
        this._length = length;

        // Read data (and header)
        this._data = this.getData(buf);

        // Store context
        this._context = context;
    }

    public get isEndOfMessage(): boolean {
        return this._endOfMessage;
    }

    public get id(): number {
        return this._id;
    }

    public get serial(): number {
        return this._serial;
    }

    public get data(): any {
        return this._data;
    }

    public get context(): any {
        return this._context;
    }

    /**
     * Read and store header data from the chunk.
     *
     * @param reader The chunk's header bytes as a DataView.
     */
    protected readHeader(reader: DataView) {
        // Read header
        const options = reader.getUint8(0);
        this._endOfMessage = (options & 0x01) == 1;
        this._id = reader.getUint32(1);
        this._serial = reader.getUint32(5);
    }

    /**
     * Return the chunk's data.
     * Important: You must read the header yourselves! Call readHeader for that purpose.
     *
     * @param buf The chunk's raw data.
     * @returns The chunk's data (without header).
     */
    protected abstract getData(buf: any): any;
}

/**
 * Helper class to access chunk information for Blob-based messages.
 */
class BlobChunk extends Chunk {
    protected getData(buf: [ArrayBuffer, Blob]): Blob {
        const [header, data] = buf;

        // Read header
        this.readHeader(new DataView(header));

        // Return data
        return data;
    }
}

/**
 * Helper class to access chunk information for Uint8Array-based messages.
 */
class Uint8ArrayChunk extends Chunk {
    protected getData(buf: ArrayBuffer): Uint8Array {
        // Read header
        this.readHeader(new DataView(buf));

        // Copy and return data
        // Note: We copy the data bytes instead of getting a reference to a subset of the buffer.
        // This is less ideal for performance, but avoids bugs that can occur
        // by 3rd party modification of the ArrayBuffer.
        // TODO: Performance. Is there a way to freeze a Uint8Array temporarily?
        return new Uint8Array(buf.slice(Common.HEADER_LENGTH));
    }
}

/**
 * Create a new Chunk instance from a data source.
 *
 * @param buf The raw data of the chunk.
 * @param context
 * @returns A promise containing the Chunk instance.
 */
export async function createChunk(buf: any, context?: any): Promise<Chunk> {
    if (buf instanceof Blob) {
        // This check needs to be done early because we need to convert
        // the first n bytes before constructing the Chunk
        const length = buf.size;
        if (length < Common.HEADER_LENGTH) {
            throw new Error('Invalid chunk: Too short');
        }

        // Need to make the header to an ArrayBuffer first
        const reader = new FileReader();
        const headerBlob = buf.slice(0, Common.HEADER_LENGTH);
        const headerBuf = await new Promise((resolve, reject) => {
            reader.onload = () => {
                resolve(reader.result);
            };
            reader.onerror = () => {
                reject('Unable to read header from Blob')
            };
            reader.readAsArrayBuffer(headerBlob);
        });

        // Create instance
        return new BlobChunk([headerBuf, buf.slice(Common.HEADER_LENGTH)], buf.size, context);
    } else if (buf instanceof Uint8Array) {
        return new Uint8ArrayChunk(buf.buffer, buf.byteLength, context);
    } else if (buf instanceof ArrayBuffer) {
        return new Uint8ArrayChunk(buf, buf.byteLength, context);
    } else {
        throw TypeError('Cannot create chunk from type ' + typeof buf);
    }
}

/**
 * Helper class to hold chunks and an "end-arrived" flag.
 */
abstract class ChunkCollector {
    private endArrived: boolean;
    private lastUpdate: number = new Date().getTime();
    protected messageLength: number = null;
    protected chunks: Chunk[] = [];

    /**
     * Register a new chunk. Return a boolean indicating whether the chunk was added.
     */
    public addChunk(chunk: Chunk): void {
        // Ignore repeated chunks with the same serial
        if (this.hasSerial(chunk.serial)) {
            return;
        }

        // Add chunk
        this.chunks.push(chunk);

        // Process chunk
        this.lastUpdate = new Date().getTime();
        if (chunk.isEndOfMessage) {
            this.endArrived = true;
            this.messageLength = chunk.serial + 1;
        }
    }

    /**
     * Return whether this chunk collector already contains a chunk with the specified serial.
     */
    public hasSerial(serial: number): boolean {
        // TODO: Performance. Slow?
        return this.chunks.find(
            (chunk: Chunk) => chunk.serial == serial
        ) !== undefined;
    }

    /**
     * Return whether the message is complete, meaning that all chunks of the message arrived.
     */
    public get isComplete() {
        return this.endArrived && this.chunks.length == this.messageLength;
    }

    /**
     * Merge the chunks into a single message.
     *
     * Note: This implementation assumes that no chunk will be larger than the first one!
     * If this is not the case, an error may be thrown.
     *
     * @return An object containing the message and a (possibly empty) list of context
     *          objects.
     * @throws Error if message is not yet complete.
     */
    public merge(): {message: any, context: any[]} {
        // TODO: Performance. Merging all at once in the end is usually slow compared
        //       to merging with each chunk.

        // Preconditions
        if (!this.isComplete) {
            throw new Error('Not all chunks for this message have arrived yet.');
        }

        // Sort chunks
        this.chunks.sort((a: Chunk, b: Chunk) => {
            if (a.serial < b.serial) {
                return -1;
            } else if (a.serial > b.serial) {
                return 1;
            }
            return 0;
        });

        // Merge data chunks and contexts to a result object
        return this.mergeChunks();
    }

    /**
     * Low-level method to merge the data chunks and the contexts into a single message.
     *
     * @return An object containing the message and a list of context objects.
     */
    protected abstract mergeChunks(): { message: any; context: any[]; };

    /**
     * Return whether last chunk is older than the specified number of miliseconds.
     */
    public isOlderThan(maxAge: number): boolean {
        const age = (new Date().getTime() - this.lastUpdate);
        return age > maxAge;
    }

    /**
     * Return the number of registered chunks.
     */
    public get chunkCount(): number {
        return this.chunks.length;
    }
}

/**
 * Helper class to hold Blob-based chunks and an "end-arrived" flag.
 */
class BlobChunkCollector extends ChunkCollector {
    protected mergeChunks(): { message: Blob; context: any[]; } {
        // Create message Blob from chunks
        const firstSize = this.chunks[0].data.size;
        const contextList = [];
        const dataList = this.chunks.map((chunk: Chunk) => {
            if (chunk.data.size > firstSize) {
                throw new Error('No chunk may be larger than the first chunk of that message.');
            }
            if (chunk.context !== undefined) {
                contextList.push(chunk.context);
            }
            return chunk.data;
        });

        // Return result object
        return {
            message: new Blob(dataList),
            context: contextList,
        };
    }
}

/**
 * Helper class to hold Uint8Array-based chunks and an "end-arrived" flag.
 */
class Uint8ArrayChunkCollector extends ChunkCollector {
    protected mergeChunks(): { message: Uint8Array; context: any[]; } {
        // Allocate buffer
        const capacity = this.chunks[0].data.byteLength * this.messageLength;
        const buf = new Uint8Array(new ArrayBuffer(capacity));

        // Add chunks to buffer
        let offset = 0;
        const firstSize = this.chunks[0].data.byteLength;
        const contextList = [];
        for (let chunk of this.chunks) {
            if (chunk.data.byteLength > firstSize) {
                throw new Error('No chunk may be larger than the first chunk of that message.');
            }
            buf.set(chunk.data, offset);
            offset += chunk.data.length;
            if (chunk.context !== undefined) {
                contextList.push(chunk.context);
            }
        }

        // Return result object
        return {
            message: buf.slice(0, offset), // TODO: Can we avoid this copy?
            context: contextList,
        };
    }
}

/**
 * A Unchunker instance merges multiple chunks into a single message.
 *
 * It keeps track of IDs, so only one Unchunker instance is necessary
 * to receive multiple messages.
 */
export abstract class Unchunker {
    private chunks: Map<number, ChunkCollector> = new Map();

    /**
     * Message listener. Set by the user.
     */
    public onMessage: (message: any, context?: any[]) => void = null;

    /**
     * Add a chunk.
     *
     * @param buf A chunk with 9 byte header.
     * @param context Arbitrary data that will be registered with the chunk and will be passed to the callback.
     * @throws Error if message is smaller than the header length.
     */
    public async add(buf: any, context?: any): Promise<void> {
        // Parse chunk
        const chunk = await createChunk(buf, context);

        // Ignore repeated chunks with the same serial
        if (this.chunks.has(chunk.id) && this.chunks.get(chunk.id).hasSerial(chunk.serial)) {
            return;
        }

        // If this is the only chunk in the message, return it immediately.
        if (chunk.isEndOfMessage && chunk.serial == 0) {
            this.notifyListener(chunk.data, context === undefined ? [] : [context]);
            this.chunks.delete(chunk.id);
            return;
        }

        // Otherwise, add chunk to chunks list
        let collector: ChunkCollector;
        if (this.chunks.has(chunk.id)) {
            collector = this.chunks.get(chunk.id);
        } else {
            collector = this.createChunkCollector();
            this.chunks.set(chunk.id, collector);
        }
        collector.addChunk(chunk);

        // Check if message is complete
        if (collector.isComplete) {
            // Merge and notify listener...
            const merged = collector.merge();
            this.notifyListener(merged.message, merged.context);
            // ...then delete the chunks.
            this.chunks.delete(chunk.id);
        }
    }

    /**
     * If a message listener is set, notify it about a complete message.
     */
    private notifyListener(message: any, context: any[]) {
        if (this.onMessage != null) {
            this.onMessage(message, context);
        }
    }

    /**
     * Create a chunk collector instance.
     */
    protected abstract createChunkCollector(): ChunkCollector;

    /**
     * Run garbage collection, remove incomplete messages that haven't been
     * updated for more than the specified number of milliseconds.
     *
     * If you want to make sure that invalid chunks don't fill up memory, call
     * this method regularly.
     *
     * @param maxAge Remove incomplete messages that haven't been updated for
     *               more than the specified number of milliseconds.
     * @return the number of removed chunks.
     */
    public gc(maxAge: number): number {
        let removedItems = 0;
        for (let entry of this.chunks) {
            const msgId: number = entry[0];
            const collector: ChunkCollector = entry[1];
            if (collector.isOlderThan(maxAge)) {
                removedItems += collector.chunkCount;
                this.chunks.delete(msgId);
            }
        }
        return removedItems;
    }
}

/**
 * A BlobUnchunker instance merges multiple chunks into a single Blob message.
 *
 * It keeps track of IDs, so only one BlobUnchunker instance is necessary
 * to receive multiple messages.
 */
export class BlobUnchunker extends Unchunker {
    /**
     * Message listener. Set by the user.
     */
    public onMessage: (message: Blob, context?: any[]) => void = null;

    protected createChunkCollector(): ChunkCollector {
        return new BlobChunkCollector();
    }
}

/**
 * A Uint8ArrayUnchunker instance merges multiple chunks into a single Uint8Array message.
 *
 * It keeps track of IDs, so only one Uint8ArrayUnchunker instance is necessary
 * to receive multiple messages.
 */
export class Uint8ArrayUnchunker extends Unchunker {
    /**
     * Message listener. Set by the user.
     */
    public onMessage: (message: Uint8Array, context?: any[]) => void = null;

    protected createChunkCollector(): ChunkCollector {
        return new Uint8ArrayChunkCollector();
    }
}
