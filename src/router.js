function pathMatches(pattern, path) {
    // /abcd - /abcd
    // /abc?d - /abcd, /abd
    // /ab+cd - /abcd, /abbcd, /abbbbbcd, and so on
    // /ab*cd -  /abcd, /abxcd, /abFOOcd, /abbArcd, and so on
    // /a(bc)?d - /ad and /abcd
    // /:test - /a, /b, /c as query params
    // /* - anything
    // /test/* - /test/a, /test/b, /test/c, /test/a/b/c, and so on
    // /test/:test - /test/a, /test/b, /test/c, /test/a/b/c, and so on

    if(pattern instanceof RegExp) {
        return pattern.test(path);
    }
    
    if(pattern === '*' || pattern === '/*') {
        return true;
    }

    // Convert pattern to regex
    const regexPattern = pattern
        .replace(/\//g, '\\/') // Escape forward slashes
        .replace(/\?/g, '\\?') // Escape question marks
        .replace(/\+/g, '.+') // Convert + to .+
        .replace(/\*/g, '.*') // Convert * to .*
        .replace(/\(([^)]+)\)\?/g, '(?:$1)?') // Handle optional groups
        .replace(/:(\w+)/g, '([^/]+)'); // Convert :param to capture group

    // Create regex object with start and end anchors
    const regex = new RegExp(`^${regexPattern}$`);

    // Test the path against the regex
    return regex.test(path);
}

export default class Router {
    #app;
    #routes;
    constructor(app) {
        this.#app = app;
        this.#routes = [];
    }
    #createRoute(method, path, callback) {
        this.#routes.push({ method, path, callback });
    }
    async route(req, res, i = 0) {
        return new Promise(async (resolve, reject) => {
            while (i < this.#routes.length) {
                const route = this.#routes[i];
                if ((route.method === 'ALL' || route.method === req.method) && pathMatches(route.path, req.path)) {
                    let calledNext = false;
                    await route.callback(req, res, function next() {
                        calledNext = true;
                        resolve(this.route(req, res, i + 1));
                    });
                    if(!calledNext) {
                        resolve(true);
                    }
                }
                i++;
            }
            resolve(false);
        });
    }
    get(path, callback) {
        this.#createRoute('GET', path, callback);
    }
}