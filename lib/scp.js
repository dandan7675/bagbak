import { EventEmitter } from 'events';
import { WriteStream, createWriteStream, promises as fsp } from 'fs';
import path from 'path';
import { Duplex } from 'stream';
import { promisify } from 'util';

import { Client } from 'ssh2';

import { enableDebug, passthrough } from './utils.js';


const State = {
  Init: 0,
  Readline: 1,
  Data: 2
}

class SCPReceiver extends Duplex {
  #state = State.Init;

  #remain = 0;
  #size = 0;

  /**
   * @type {WriteStream | null}
   * @private
   */
  output = null;

  /**
   * @type {Date | null}
   * @private
   */
  mtime = null;

  /**
   * @type {Date | null}
   * @private
   */
  atime = null;

  #dest;
  #recursive;

  /**
   * @type {string[]}
   */
  #components;

  #currentRemote = '';

  /**
   * 
   * @param {string} dest 
   * @param {boolean} recursive 
   */
  constructor(dest, recursive) {
    super();
    this.#dest = dest;
    this.#recursive = recursive;
    this.#components = [];
  }

  /**
   * 
   * @param {string} basename 
   * @returns 
   */
  #localName(basename) {
    const parent = path.resolve(this.#dest, ...this.#components);
    const full = path.resolve(parent, basename);

    const relative = path.relative(parent, full);
    // no special charactor and inside parent
    if (basename !== path.basename(full) || relative !== basename)
      throw new Error('Invalid path');

    return full;
  }

  /**
   * 
   * @param {string} basename 
   */
  #remoteName(basename) {
    return [...this.#components, basename].join('/');
  }

  #ack() {
    this.push(Buffer.from([0]));
  }

  /**
   * 
   * @param {string} name
   */
  #pushd(name) {
    this.#components.push(name);
  }

  #popd() {
    this.#components.pop();
  }

  _read() {
    if (this.#state == State.Init) {
      this.#ack();
      this.#state = State.Readline;
    }
  }

  /**
   * 
   * @param {Buffer} buf 
   * @returns 
   */
  async #handleLine(buf) {
    const line = buf.toString();

    if (line == 'E') { // sink
      this.#state = State.Readline;
      this.#popd();
      return;
    }

    if (line.startsWith('T')) { // time
      const values = line.substring(1).split(' ').map(str => parseInt(str, 10));
      if (values.length !== 4)
        throw new Error(`Protocol Error, response: ${line}`);

      const [mtime, mtimeNsec, atime, atimeNsec] = values;
      if (mtimeNsec > 999999 || atimeNsec > 999999)
        throw new Error(`time out of range: ${line}`);

      this.mtime = new Date(mtime * 1000 + mtimeNsec / 1000000);
      this.atime = new Date(atime * 1000 + atimeNsec / 1000000);
      return;
    }

    const isFile = line.startsWith('C');
    const isDir = line.startsWith('D');

    if (!isFile && !isDir) {
      throw new Error(`Protocol Error, response: ${line}`);
    }

    const [strMode, strSize, ...tail] = line.split(' ');
    const basename = tail.join(' ');

    const mode = parseInt(strMode.slice(1), 8);
    const size = parseInt(strSize, 10);
    if (basename.includes('/')) throw new Error('Invalid path');

    const name = basename.trimEnd();
    const dest = this.#recursive ? this.#localName(name) : this.#dest;
    const src = this.#currentRemote = this.#remoteName(name);

    if (isFile) {
      this.emit('download', src, size);
      this.emit('progress', src, 0, size);
      this.#state = State.Data;
      this.output = createWriteStream(dest, { mode });
      this.#size = this.#remain = size;
    } else if (isDir) {
      this.emit('mkdir', src);
      await fsp.mkdir(dest, { recursive: true });
      if (this.atime && this.mtime) {
        await fsp.utimes(dest, this.atime, this.mtime);
      }
      this.#pushd(name);
    }
  }

  /**
   * 
   * @param {Buffer} chunk 
   * @param {BufferEncoding} encoding 
   * @param {function} callback
   */
  _write(chunk, encoding, callback) {
    if (this.#state == State.Readline) {
      if (chunk[chunk.length - 1] !== 0x0A)
        return callback(new Error('Invalid protocol, expect \\n'));

      this.#handleLine(chunk.toString().trimEnd());
      this.#ack();
    } else if (this.#state == State.Data) {
      if (!this.output)
        return callback(new Error('Invalid state'));

      const src = this.#currentRemote;
      if (chunk.length > this.#remain) {
        const current = this.output.path;
        const { mtime, atime } = this;
        if (atime && mtime) {
          this.output.once('finish', async () => {
            this.#ack();
            fsp.utimes(current, atime, mtime);
          });
        }
        if (chunk[this.#remain] !== 0)
          return callback(new Error('Protocol Error'));
        this.output.end(chunk.slice(0, this.#remain));
        this.#state = State.Readline;
        this.#remain = 0;
        this.#size = 0;
      } else {
        this.output.write(chunk);
        this.#remain -= chunk.length;
      }
      
      this.emit('progress', src, this.output.bytesWritten, this.#size);
      this.emit('done', src);
    } else {
      callback(new Error('Invalid state'));
    }
    callback();
  }
}

/**
 * @param {string} arg
 * @returns {string} escaped filename
 * @private
 */

export function quote(name) {
  return `'${name.replace(/'/g, `'\\''`)}'`;
}

export class Pull extends EventEmitter {
  /**
   * @private
   * @type {Client}
   */
  #client;

  /**
   * @private
   * @type {boolean}
   * @default true
   */
  #recursive;

  /**
   * @private
   * @type {PathLike}
   */
  #remote;

  /**
   * @private
   * @type {PathLike}
   * @default '.'
   */
  #local;

  /**
   * 
   * @param {Client} client 
   * @param {PathLike} remote 
   * @param {PathLike} local 
   * @param {boolean} recursive 
   */
  constructor(client, remote, local = '.', recursive = true) {
    super();

    this.#client = client;
    this.#recursive = recursive;
    this.#remote = quote(remote);
    this.#local = local;
  }

  async start() {
    const exec = promisify(this.#client.exec.bind(this.#client));
    const stream = await exec(`scp -v -f -p ${this.#recursive ? '-r' : ''} ${this.#remote}`);

    const receiver = new SCPReceiver(this.#local, this.#recursive);
    stream.stdout.pipe(receiver);
    receiver.pipe(stream.stdin);

    passthrough(receiver, this);

    if (enableDebug()) {
      stream.stderr.pipe(process.stderr);
    }

    await new Promise((resolve, reject) => {
      receiver
        .on('finish', resolve)
        .on('error', reject);
    });
  }

}