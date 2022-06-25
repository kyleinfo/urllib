import { EventEmitter } from 'events';
import { debuglog } from 'util';
import zlib from 'zlib';
import { Blob } from 'buffer';
import { Readable, isReadable, pipeline, promises as streamPromise } from 'stream';
import { basename } from 'path';
import { createReadStream } from 'fs';
import { IncomingHttpHeaders } from 'http';
import {
  FormData,
  request as undiciRequest,
  Dispatcher,
} from 'undici';
import createUserAgent from 'default-user-agent';
import mime from 'mime-types';
import { RequestURL, RequestOptions, HttpMethod } from './Request';
import { HttpClientResponseMeta, HttpClientResponse, ReadableWithMeta } from './Response';
import { parseJSON } from './utils';

const debug = debuglog('urllib');

export type ClientOptions = {
  defaultArgs?: RequestOptions;
};

type UndiciRquestOptions = Omit<Dispatcher.RequestOptions, 'origin' | 'path' | 'method'> & Partial<Pick<Dispatcher.RequestOptions, 'method'>>;

// https://github.com/octet-stream/form-data
class BlobFromStream {
  #stream;
  #type;
  constructor(stream: Readable, type: string) {
    this.#stream = stream;
    this.#type = type;
  }

  stream() {
    return this.#stream;
  }

  get type(): string {
    return this.#type;
  }

  get [Symbol.toStringTag]() {
    return 'Blob';
  }
}

class HttpClientRequestTimeoutError extends Error {
  constructor(timeout: number, options: ErrorOptions) {
    const message = `Request timeout for ${timeout} ms`;
    super(message, options);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

const HEADER_USER_AGENT = createUserAgent('node-urllib', '3.0.0');

function getFileName(stream: Readable) {
  const filePath: string = (stream as any).path;
  if (filePath) {
    return basename(filePath);
  }
  return '';
}

export class HttpClient extends EventEmitter {
  defaultArgs?: RequestOptions;

  constructor(clientOptions?: ClientOptions) {
    super();
    this.defaultArgs = clientOptions?.defaultArgs;
  }

  async request(url: RequestURL, options?: RequestOptions) {
    const requestUrl = typeof url === 'string' ? new URL(url) : url;
    const args = {
      ...this.defaultArgs,
      ...options,
      emitter: this,
    };
    const requestStartTime = Date.now();
    // keep urllib createCallbackResponse style
    const resHeaders: IncomingHttpHeaders = {};
    const res: HttpClientResponseMeta = {
      status: -1,
      statusCode: -1,
      statusMessage: '',
      headers: resHeaders,
      size: 0,
      aborted: false,
      rt: 0,
      keepAliveSocket: true,
      requestUrls: [],
      timing: {
        contentDownload: 0,
      },
    };

    let headersTimeout = 5000;
    let bodyTimeout = 5000;
    if (args.timeout) {
      if (Array.isArray(args.timeout)) {
        headersTimeout = args.timeout[0] ?? headersTimeout;
        bodyTimeout = args.timeout[1] ?? bodyTimeout;
      } else {
        headersTimeout = bodyTimeout = args.timeout;
      }
    }

    const method = (args.method ?? 'GET').toUpperCase() as HttpMethod;
    const headers: IncomingHttpHeaders = {};
    if (args.headers) {
      // convert headers to lower-case
      for (const name in args.headers) {
        headers[name.toLowerCase()] = args.headers[name];
      }
    }
    // hidden user-agent
    const hiddenUserAgent = 'user-agent' in headers && !headers['user-agent'];
    if (hiddenUserAgent) {
      delete headers['user-agent'];
    } else if (!headers['user-agent']) {
      // need to set user-agent
      headers['user-agent'] = HEADER_USER_AGENT;
    }
    if (args.dataType === 'json' && !headers.accept) {
      headers.accept = 'application/json';
    }
    if (args.gzip) {
      headers['accept-encoding'] = 'gzip, deflate';
    }

    try {
      const requestOptions: UndiciRquestOptions = {
        method,
        keepalive: true,
        maxRedirections: args.maxRedirects ?? 10,
        headersTimeout,
        bodyTimeout,
        headers,
      };
      if (args.followRedirect === false) {
        requestOptions.maxRedirections = 0;
      }

      const isGETOrHEAD = requestOptions.method === 'GET' || requestOptions.method === 'HEAD';
      // alias to args.content
      if (args.stream && !args.content) {
        args.content = args.stream;
      }

      if (args.files) {
        if (isGETOrHEAD) {
          requestOptions.method = 'POST';
        }
        const formData = new FormData();
        const uploadFiles: [string, string | Readable | Buffer][] = [];
        if (Array.isArray(args.files)) {
          for (const [ index, file ] of args.files.entries()) {
            const field = index === 0 ? 'file' : `file${index}`;
            uploadFiles.push([ field, file ]);
          }
        } else if (args.files instanceof Readable || isReadable(args.files as any)) {
          uploadFiles.push([ 'file', args.files as Readable ]);
        } else if (typeof args.files === 'string' || Buffer.isBuffer(args.files)) {
          uploadFiles.push([ 'file', args.files ]);
        } else if (typeof args.files === 'object') {
          for (const field in args.files) {
            uploadFiles.push([ field, args.files[field] ]);
          }
        }
        // set normal fields first
        if (args.data) {
          for (const field in args.data) {
            formData.append(field, args.data[field]);
          }
        }
        for (const [ index, [ field, file ]] of uploadFiles.entries()) {
          if (typeof file === 'string') {
            // FIXME: support non-ascii filename
            // const fileName = encodeURIComponent(basename(file));
            // formData.append(field, await fileFromPath(file, `utf-8''${fileName}`, { type: mime.lookup(fileName) || '' }));
            const fileName = basename(file);
            const fileReadable = createReadStream(file);
            formData.append(field, new BlobFromStream(fileReadable, mime.lookup(fileName) || ''), fileName);
          } else if (Buffer.isBuffer(file)) {
            formData.append(field, new Blob([ file ]), `bufferfile${index}`);
          } else if (file instanceof Readable || isReadable(file as any)) {
            const fileName = getFileName(file) || `streamfile${index}`;
            formData.append(field, new BlobFromStream(file, mime.lookup(fileName) || ''), fileName);
          }
        }
        requestOptions.body = formData;
      } else if (args.content) {
        if (!isGETOrHEAD) {
          // handle content
          requestOptions.body = args.content;
          if (args.contentType) {
            headers['content-type'] = args.contentType;
          }
          if (typeof args.content === 'string' && !headers['content-type']) {
            headers['content-type'] = 'text/plain;charset=UTF-8';
          }
        }
      } else if (args.data) {
        const isStringOrBufferOrReadable = typeof args.data === 'string'
          || Buffer.isBuffer(args.data)
          || isReadable(args.data);
        if (isGETOrHEAD) {
          if (!isStringOrBufferOrReadable) {
            for (const field in args.data) {
              requestUrl.searchParams.append(field, args.data[field]);
            }
          }
        } else {
          if (isStringOrBufferOrReadable) {
            requestOptions.body = args.data;
          } else {
            if (args.contentType === 'json'
              || args.contentType === 'application/json'
              || headers['content-type']?.startsWith('application/json')) {
              requestOptions.body = JSON.stringify(args.data);
              if (!headers['content-type']) {
                headers['content-type'] = 'application/json';
              }
            } else {
              headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
              requestOptions.body = new URLSearchParams(args.data).toString();
            }
          }
        }
      }

      debug('%s %s, headers: %j, timeout: %s,%s',
        requestOptions.method, url, headers, headersTimeout, bodyTimeout);
      const response = await undiciRequest(requestUrl, requestOptions);
      const context = response.context as { history: URL[] };
      let lastUrl = '';
      if (context?.history) {
        for (const urlObject of context?.history) {
          res.requestUrls.push(urlObject.href);
          lastUrl = urlObject.href;
        }
      } else {
        res.requestUrls.push(requestUrl.href);
        lastUrl = requestUrl.href;
      }
      const contentEncoding = response.headers['content-encoding'];
      const isCompressContent = contentEncoding === 'gzip' || contentEncoding === 'deflate';

      res.headers = response.headers;
      res.status = res.statusCode = response.statusCode;
      // res.statusMessage = response.statusText;
      // if (response.redirected) {
      //   res.requestUrls.push(response.url);
      // }
      if (res.headers['content-length']) {
        res.size = parseInt(res.headers['content-length']);
      }

      let data: any = null;
      let responseBodyStream: ReadableWithMeta | undefined;
      if (args.streaming || args.dataType === 'stream') {
        const meta = {
          status: res.status,
          statusCode: res.statusCode,
          headers: res.headers,
        };
        if (isCompressContent) {
          const decoder = contentEncoding === 'gzip' ? zlib.createGunzip() : zlib.createInflate();
          responseBodyStream = Object.assign(pipeline(response.body, decoder), meta);
        } else {
          responseBodyStream = Object.assign(response.body, meta);
        }
      } else if (args.writeStream) {
        if (isCompressContent) {
          const decoder = contentEncoding === 'gzip' ? zlib.createGunzip() : zlib.createInflate();
          await streamPromise.pipeline(response.body, decoder, args.writeStream);
        } else {
          await streamPromise.pipeline(response.body, args.writeStream);
        }
      } else {
        // buffer
        data = Buffer.from(await response.body.arrayBuffer());
        if (isCompressContent) {
          try {
            data = contentEncoding === 'gzip' ? zlib.gunzipSync(data) : zlib.inflateSync(data);
          } catch (err: any) {
            if (err.name === 'Error') {
              err.name = 'UnzipError';
            }
            throw err;
          }
        }
        if (args.dataType === 'text') {
          data = data.toString();
        } else if (args.dataType === 'json') {
          if (data.length === 0) {
            data = null;
          } else {
            data = parseJSON(data.toString(), args.fixJSONCtlChars);
          }
        }
      }
      res.rt = res.timing.contentDownload = Date.now() - requestStartTime;

      const clientResponse: HttpClientResponse = {
        data,
        status: res.status,
        headers: res.headers,
        url: lastUrl,
        redirected: res.requestUrls.length > 1,
        requestUrls: res.requestUrls,
        res: responseBodyStream ?? res,
      };
      return clientResponse;
    } catch (e: any) {
      debug('throw error: %s', e);
      let err = e;
      if (err.name === 'HeadersTimeoutError') {
        err = new HttpClientRequestTimeoutError(headersTimeout, { cause: e });
      } else if (err.name === 'BodyTimeoutError') {
        err = new HttpClientRequestTimeoutError(bodyTimeout, { cause: e });
      }
      err.status = res.status;
      err.headers = res.headers;
      err.res = res;
      throw err;
    }
  }
}