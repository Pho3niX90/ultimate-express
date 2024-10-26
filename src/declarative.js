const acorn = require("acorn");
const util = require("util");
const uWS = require("uWebSockets.js");

const parser = acorn.Parser;

const allowedResMethods = ['set', 'header', 'setHeader', 'status', 'send', 'end', 'append'];
const allowedIdentifiers = ['query', 'params', ...allowedResMethods];

const fn = function(req, res, next) {
    res.send(null);
};

module.exports = function compileDeclarative(cb, app) {
    try {
        let code = cb.toString();
        // convert anonymous functions to named ones to make it valid code
        if(code.startsWith("function") || code.startsWith("async function")) {
            code = code.replace(/function *\(/, "function __cb(");
        }

        const tokens = [...acorn.tokenizer(code, { ecmaVersion: "latest" })];

        if(tokens.some(token => ['throw', 'new', 'await'].includes(token.value))) {
            return false;
        }

        const parsed = parser.parse(code, { ecmaVersion: "latest" }).body;
        let fn = parsed[0];

        if(fn.type === 'ExpressionStatement') {
            fn = fn.expression;
        }

        // console.log(tokens, util.inspect(fn, { depth: 100, colors: true }));
        // console.log("===============")
        
        // check if it is a function
        if (fn.type !== 'FunctionDeclaration' && fn.type !== 'ArrowFunctionExpression') {
            return false;
        }

        const args = fn.params.map(param => param.name);

        if(args.length < 2) {
            // invalid function? doesn't have (req, res) args
            return false;
        }

        const [req, res] = args;

        // check if it calls any other function other than the one in `res`
        const callExprs = filterNodes(fn, node => node.type === 'CallExpression');
        const resCalls = [];
        for(let expr of callExprs) {
            let calleeName, propertyName;

            
            // get propertyName
            if(expr.type === 'MemberExpression') {
                propertyName = expr.property.name;
            } else if(expr.type === 'CallExpression') {
                propertyName = expr.callee?.property?.name ?? expr.callee?.name;
            }

            // get calleeName
            switch(expr.callee.type) {
                case "Identifier":
                    calleeName = expr.callee.name;
                    break;
                case "MemberExpression":
                    if(expr.callee.object.type === 'Identifier') {
                        calleeName = expr.callee.object.name;
                    } else if(expr.callee.object.type === 'CallExpression') {
                        // function call chaining
                        let callee = expr.callee;
                        while(callee.object.callee) {
                            callee = callee.object.callee;
                        }
                        if(callee.object.type !== 'Identifier') {
                            return false;
                        }
                        calleeName = callee.object.name;
                    }
                    break;
                default:
                    return false;
            }
            // check if calleeName is res
            if(calleeName !== res) {
                return false;
            }

            const obj = { calleeName, propertyName };
            expr.obj = obj;
            resCalls.push(obj);
        }

        // check if res property being called are
        // - set, header, setHeader
        // - status
        // - send
        // - end
        for(let call of resCalls) {
            if(!allowedResMethods.includes(call.propertyName)) {
                return false;
            }
        }

        // check if all identifiers are allowed
        const identifiers = filterNodes(fn, node => node.type === 'Identifier').slice(args.length).map(id => id.name);
        if(identifiers[identifiers.length - 1] === '__cb') {
            identifiers.pop();
        }
        if(!identifiers.every((id, i) => 
            allowedIdentifiers.includes(id) || 
            id === req || 
            id === res || 
            (identifiers[i - 2] === 'req' && identifiers[i - 1] === 'params') || 
            (identifiers[i - 2] === 'req' && identifiers[i - 1] === 'query')
        )) {
            return false;
        }
        
        let statusCode = 200;
        const headers = [];
        const body = [];

        // get statusCode
        for(let call of callExprs) {
            if(call.obj.propertyName === 'status') {
                if(call.arguments[0].type !== 'Literal') {
                    return false;
                }
                statusCode = call.arguments[0].value;
            }
        }

        // get headers
        for(let call of callExprs) {
            if(call.obj.propertyName === 'header' || call.obj.propertyName === 'setHeader' || call.obj.propertyName === 'set') {
                if(call.arguments[0].type !== 'Literal' || call.arguments[1].type !== 'Literal') {
                    return false;
                }
                const sameHeader = headers.find(header => header[0] === call.arguments[0].value);
                if(sameHeader) {
                    sameHeader[1] = call.arguments[1].value;
                } else {
                    headers.push([call.arguments[0].value, call.arguments[1].value]);
                }
            } else if(call.obj.propertyName === 'append') {
                if(call.arguments[0].type !== 'Literal' || call.arguments[1].type !== 'Literal') {
                    return false;
                }
                headers.push([call.arguments[0].value, call.arguments[1].value]);
            }
        }

        // get body
        for(let call of callExprs) {
            if(call.obj.propertyName === 'send' || call.obj.propertyName === 'end') {
                const arg = call.arguments[0];
                if(arg) {
                    if(arg.type === 'Literal') {
                        if(typeof arg.value === 'number') { // status code
                            return false;
                        }
                        let val = arg.value;
                        if(val === null) {
                            val = '';
                        }
                        body.push({type: 'text', value: val});
                    } else if(arg.type === 'TemplateLiteral') {
                        const exprs = [...arg.quasis, ...arg.expressions].sort((a, b) => a.start - b.start);
                        for(let expr of exprs) {
                            if(expr.type === 'TemplateElement') {
                                body.push({type: 'text', value: expr.value.cooked});
                            } else if(expr.type === 'MemberExpression') {
                                const obj = expr.object;
                                if(obj.type !== 'MemberExpression' || obj.property.type !== 'Identifier') {
                                    return false;
                                }
                                const type = obj.property.name;
                                if(type !== 'params' && type !== 'query') {
                                    return false;
                                }
                                body.push({type: obj.property.name, value: expr.property.name});
                            }
                        }
                    } else if(arg.type === 'MemberExpression') {
                        body.push({type: arg.object.property.name, value: arg.property.name});
                    } else if(arg.type === 'BinaryExpression') {
                        let stuff = [];
                        function check(node) {
                            if(node.right.type === 'Literal') {
                                stuff.push({type: 'text', value: node.right.value});
                            } else if(node.right.type === 'MemberExpression')  {
                                stuff.push({type: node.right.object.property.name, value: node.right.property.name});
                            } else return false;
                            if(node.left.type === 'Literal') {
                                stuff.push({type: 'text', value: node.left.value});
                            } else if(node.left.type === 'MemberExpression') {
                                stuff.push({type: node.left.object.property.name, value: node.left.property.name});
                            } else if(node.left.type === 'BinaryExpression') {
                                return check(node.left);
                            } else return false;

                            return true;
                        }
                        if(!check(arg)) {
                            return false;
                        }
                        body.push(...stuff.reverse());
                    } else {
                        return false;
                    }
                }
            }
        }

        // uws doesnt support status codes other than 200 currently
        if(statusCode != 200) {
            return false;
        }

        let decRes = new uWS.DeclarativeResponse();

        for(let header of headers) {
            if(header[0].toLowerCase() === 'content-length') {
                return false;
            }
            decRes = decRes.writeHeader(header[0], header[1]);
        }

        if(app.get('etag') && !headers.some(header => header[0].toLowerCase() === 'etag')) {
            if(body.some(part => part.type !== 'text')) {
                return false;
            } else {
                decRes = decRes.writeHeader('ETag', app.get('etag fn')(body.map(part => part.value).join('')));
            }
        }

        if(app.get('x-powered-by')) {
            decRes = decRes.writeHeader('x-powered-by', 'UltimateExpress');
        }

        for(let bodyPart of body) {
            if(bodyPart.type === 'text') {
                decRes = decRes.write(bodyPart.value);
            } else if(bodyPart.type === 'params') {
                decRes = decRes.writeParameterValue(bodyPart.value);
            } else if(bodyPart.type === 'query') {
                decRes = decRes.writeQueryValue(bodyPart.value);
            }
        }

        return decRes.end();
    } catch(e) {
        console.log(e);
        return false;
    }
}

function filterNodes(node, fn) {
    const filtered = [];
    if(fn(node)) {
        filtered.push(node);
    }
    if(node.params) {
        for(let param of node.params) {
            filtered.push(...filterNodes(param, fn));
        }
    }

    if(node.body) {
        if(Array.isArray(node.body)) {
            for(let child of node.body) {
                filtered.push(...filterNodes(child, fn));
            }
        } else {
            filtered.push(...filterNodes(node.body, fn));
        }
    }

    if(node.declarations) {
        for(let declaration of node.declarations) {
            filtered.push(...filterNodes(declaration, fn));
        }
    }

    if(node.expression) {
        filtered.push(...filterNodes(node.expression, fn));
    }

    if(node.callee) {
        filtered.push(...filterNodes(node.callee, fn));
    }

    if(node.object) {
        filtered.push(...filterNodes(node.object, fn));
    }

    if(node.property) {
        filtered.push(...filterNodes(node.property, fn));
    }

    if(node.id) {
        filtered.push(...filterNodes(node.id, fn));
    }
    if(node.init) {
        filtered.push(...filterNodes(node.init, fn));
    }
    
    if(node.left) {
        filtered.push(...filterNodes(node.left, fn));
    }
    if(node.right) {
        filtered.push(...filterNodes(node.right, fn));
    }

    if(node.arguments) {
        for(let argument of node.arguments) {
            filtered.push(...filterNodes(argument, fn));
        }
    }

    return filtered;
}
