const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Sử dụng Port do Render cấp phát, hoặc 3000 nếu chạy local
const PORT = process.env.PORT || 3000;

// 1. Khởi tạo HTTP Server để phục vụ giao diện Web
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                return res.end('Lỗi load giao diện Web');
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

// 2. Khởi tạo 3 bộ WebSocket độc lập
const wssVideo = new WebSocket.Server({ noServer: true });
const wssAudio = new WebSocket.Server({ noServer: true });
const wssControl = new WebSocket.Server({ noServer: true });

// Luồng Video (ESP-CAM -> Web)
wssVideo.on('connection', (ws) => {
    ws.on('message', (data) => {
        wssVideo.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) client.send(data);
        });
    });
});

// Luồng Audio (Main ESP <-> Web)
wssAudio.on('connection', (ws) => {
    ws.on('message', (data) => {
        wssAudio.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) client.send(data);
        });
    });
});

// Luồng Control (Web -> Main ESP)
wssControl.on('connection', (ws) => {
    ws.on('message', (data) => {
        wssControl.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) client.send(data);
        });
    });
});

// 3. Phân luồng dữ liệu dựa trên URL (Routing)
server.on('upgrade', (request, socket, head) => {
    const pathname = request.url;

    if (pathname === '/video') {
        wssVideo.handleUpgrade(request, socket, head, (ws) => {
            wssVideo.emit('connection', ws, request);
        });
    } else if (pathname === '/audio') {
        wssAudio.handleUpgrade(request, socket, head, (ws) => {
            wssAudio.emit('connection', ws, request);
        });
    } else if (pathname === '/control') {
        wssControl.handleUpgrade(request, socket, head, (ws) => {
            wssControl.emit('connection', ws, request);
        });
    } else {
        socket.destroy(); // Chặn các kết nối rác
    }
});

server.listen(PORT, () => {
    console.log(`Server đang chạy tại Port ${PORT}`);
});