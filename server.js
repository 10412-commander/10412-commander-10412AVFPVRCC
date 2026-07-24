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
    } else if (req.url === '/connectedsound.wav') {
        if (audioBuffer) {
            res.writeHead(200, { 'Content-Type': 'audio/wav' });
            res.end(audioBuffer);
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    } else if (req.url === '/api/sounds') {
        const soundDir = path.join(__dirname, 'defaultsound');
        fs.readdir(soundDir, (err, files) => {
            if (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify([])); 
            }
            const wavFiles = files.filter(f => f.toLowerCase().endsWith('.wav'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(wavFiles));
        });
    } else if (req.url.startsWith('/defaultsound/')) {
        const filename = decodeURIComponent(req.url.split('/')[2]);
        const filePath = path.join(__dirname, 'defaultsound', filename);
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                return res.end('Not Found');
            }
            res.writeHead(200, { 'Content-Type': 'audio/wav' });
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

// =========================================================
// HỆ THỐNG HÀNG ĐỢI ÂM THANH (AUDIO QUEUE SYSTEM)
// =========================================================
let currentAudioInterval = null;
let audioQueue = [];
let isPlaying = false;

// Hàm thêm yêu cầu phát nhạc vào hàng đợi
function addToAudioQueue(type, filename = null) {
    audioQueue.push({ type, filename });
    processAudioQueue();
}

// Hàm xử lý hàng đợi
function processAudioQueue() {
    // Nếu đang phát nhạc, hoặc không có bài nào trong hàng đợi thì dừng lại
    if (isPlaying || audioQueue.length === 0) return;

    isPlaying = true;
    const task = audioQueue.shift(); // Lấy bài đầu tiên ra khỏi hàng đợi

    if (task.type === 'DEFAULT') {
        if (!audioBuffer) {
            isPlaying = false;
            processAudioQueue(); // Bỏ qua và xét tiếp bài sau
            return;
        }
        playBufferStream(audioBuffer, 'PLAY_SOUND');
    } 
    else if (task.type === 'SPECIFIC') {
        const filePath = path.join(__dirname, 'defaultsound', task.filename);
        fs.readFile(filePath, (err, specAudioBuffer) => {
            if (err) {
                console.error("Không tìm thấy tệp:", task.filename);
                isPlaying = false;
                processAudioQueue(); // Bỏ qua nếu lỗi và chuyển bài tiếp theo
                return;
            }
            playBufferStream(specAudioBuffer, 'PLAY_SOUND:' + task.filename);
        });
    }
}

// Hàm đẩy buffer âm thanh xuống phần cứng ESP32 và gọi trình duyệt Web
function playBufferStream(buffer, webCommand) {
    // Ra lệnh cho Trình duyệt Web phát âm thanh đồng bộ
    wssControl.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(webCommand);
    });

    const chunkSize = 1024; // Gửi 1KB mỗi lần
    let offset = 44; // Bỏ qua header WAV
    
    currentAudioInterval = setInterval(() => {
        // Kiểm tra xem đã hết file chưa
        if (offset >= buffer.length) {
            clearInterval(currentAudioInterval); 
            currentAudioInterval = null;
            isPlaying = false; 
            processAudioQueue(); // Bài này đã xong, tự động gọi bài tiếp theo trong Queue!
            return;
        }
        
        const chunk = buffer.slice(offset, offset + chunkSize);
        offset += chunkSize;
        
        // Đẩy tín hiệu I2S qua mạng tới ESP32
        wssAudio.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(chunk);
            }
        });
    }, 30); 
}
// =========================================================

// Luồng Video (ESP-CAM -> Web)
wssVideo.on('connection', (ws) => {
    console.log("[Video] Có thiết bị vừa kết nối Camera, đưa standingby.wav vào hàng đợi...");
    addToAudioQueue('SPECIFIC', 'standingby.wav');
    
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
            addToAudioQueue('DEFAULT');
        }
        else if (msg.startsWith('REQ_PLAY:')) {
            const filename = msg.split(':')[1];
            addToAudioQueue('SPECIFIC', filename);
        } 
        else {
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
        socket.destroy(); 
    }
});

server.listen(PORT, () => {
    console.log(`Server đang chạy tại Port ${PORT}`);
});