import fs from 'fs';
import { parentPort } from 'worker_threads';

parentPort.on('message', (message) => {
    if(message.type === 'readFile') {
        try {
            const data = fs.readFileSync(message.path);
            const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            parentPort.postMessage({ key: message.key, data: ab }, [ab]);
        } catch(err) {
            parentPort.postMessage({ key: message.key, err: String(err) });
        }
    }
});
