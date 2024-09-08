export default class Response {
    #app;
    #res;
    #req;
    constructor(app, req, res) {
        this.#app = app;
        this.#res = res;
        this.#req = req;
        this.sent = false;
        this.statusCode = 200;
        this.headers = {
            'content-type': 'text/html'
        };
        this.body = undefined;
    }
    status(code) {
        if(this.sent) {
            throw new Error('Can\'t set status: Response was already sent');
        }
        this.statusCode = code;
        return this;
    }
    end() {
        if(this.sent) {
            throw new Error('Can\'t end response: Response was already sent');
        }
        this.#res.cork(() => {
            this.#res.writeStatus(this.statusCode.toString());
            for(const [field, value] of Object.entries(this.headers)) {
                this.#res.writeHeader(field, value);
            }
            if(this.body !== undefined) {
                this.#res.write(this.body);
            }
            this.#res.end();
            this.sent = true;
        });
    }
    send(body) {
        if(this.sent) {
            throw new Error('Can\'t write body: Response was already sent');
        }
        this.body = body;
        this.end();
    }
    set(field, value) {
        if(this.sent) {
            throw new Error('Can\'t write headers: Response was already sent');
        }
        this.headers[field.toLowerCase()] = value;
        return this;
    }
    header(field, value) {
        return this.set(field, value);
    }
    setHeader(field, value) {
        return this.set(field, value);
    }
    getHeader(field) {
        return this.headers[field.toLowerCase()];
    }
}