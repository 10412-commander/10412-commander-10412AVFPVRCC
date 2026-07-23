const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Sử dụng Port do Render cấp phát, hoặc 3000 nếu chạy local
const PORT = process.env.PORT || 3000;
// connected audio prepared 
let audioBuffer = null;
try {
    audioBuffer = fs.readFileSync(path.join(__dirname, 'connectedsound.wav'));
    console.log(`Đã tải connectedsound.wav (${audioBuffer.length} bytes)`);
} catch (err) {
    console.error('Không tìm thấy tệp connectedsound.wav');
}
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

// audio streaming logic
function broadcastSound() {
    // Ra lệnh cho Trình duyệt phát âm thanh
    wssControl.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send('PLAY_SOUND');
    });

    // 3.2. Cắt nhỏ và gửi luồng PCM cho ESP32
    if (!audioBuffer) return;
    
    const chunkSize = 1024; // Gửi 1KB mỗi lần
    let offset = 44; // Bỏ qua 44 bytes Header của file WAV
    
    const interval = setInterval(() => {
        if (offset >= audioBuffer.length) {
            clearInterval(interval); // Dừng gửi khi hết file
            return;
        }
        
        // Cắt một đoạn từ buffer
        const chunk = audioBuffer.slice(offset, offset + chunkSize);
        offset += chunkSize;
        
        // Gửi xuống tất cả thiết bị ở kênh Audio (ESP32)
        wssAudio.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(chunk);
            }
        });
    }, 30); // 1024 bytes 16-bit 16kHz tương đương 32ms. Delay 30ms để tránh hụt dữ liệu.
}
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
        const msg = data.toString();
        if (msg === 'REQ_SOUND') {
            broadcastSound();
        } else {
            wssControl.clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) client.send(data);
            });
        }
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