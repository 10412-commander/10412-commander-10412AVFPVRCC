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
    } // API endpoint to list available sound files in the defaultsound directory 
    else if (req.url === '/api/sounds') {
        const soundDir = path.join(__dirname, 'defaultsound');
        fs.readdir(soundDir, (err, files) => {
            if (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify([])); // Trả về mảng rỗng nếu thư mục không tồn tại
            }
            // Chỉ lọc lấy các tệp có đuôi .wav
            const wavFiles = files.filter(f => f.toLowerCase().endsWith('.wav'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(wavFiles));
        });
    } // API endpoint to serve a specific sound file from the defaultsound directory
    else if (req.url.startsWith('/defaultsound/')) {
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
    }
     else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

// 2. Khởi tạo 3 bộ WebSocket độc lập
const wssVideo = new WebSocket.Server({ noServer: true });
const wssAudio = new WebSocket.Server({ noServer: true });
const wssControl = new WebSocket.Server({ noServer: true });
// parameter to manage the audio streaming interval (eleminate old interval when new request comes)
let currentAudioInterval = null;
// audio streaming logic
function broadcastSound() {
    // Ra lệnh cho Trình duyệt phát âm thanh
    wssControl.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send('PLAY_SOUND');
    });

    // 3.2. Cắt nhỏ và gửi luồng PCM cho ESP32
    if (!audioBuffer) return;
    // Dừng interval cũ nếu có
    if (currentAudioInterval) clearInterval(currentAudioInterval);
    const chunkSize = 1024; // Gửi 1KB mỗi lần
    let offset = 44; // Bỏ qua 44 bytes Header của file WAV
    
    currentAudioInterval = setInterval(() => {
        if (offset >= audioBuffer.length) {
            clearInterval(currentAudioInterval); // Đã SỬA: clear đúng biến
            currentAudioInterval = null;         // Đã SỬA: reset biến về null khi hết bài
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
// function to play a specific sound file from the defaultsound directory
function playSpecificSound(filename) {
    const filePath = path.join(__dirname, 'defaultsound', filename);
    fs.readFile(filePath, (err, specAudioBuffer) => {
        if (err) {
            console.error("Không tìm thấy tệp:", filename);
            return;
        }
        
        // Ra lệnh cho Trình duyệt phát âm thanh file này
        wssControl.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send('PLAY_SOUND:' + filename);
        });

        // Nếu có bài nào đang phát thì dừng lại để nhường luồng I2S cho bài mới
        if (currentAudioInterval) clearInterval(currentAudioInterval);

        const chunkSize = 1024; 
        let offset = 44; 
        
        currentAudioInterval = setInterval(() => {
            if (offset >= specAudioBuffer.length) {
                clearInterval(currentAudioInterval); 
                currentAudioInterval = null;
                return;
            }
            const chunk = specAudioBuffer.slice(offset, offset + chunkSize);
            offset += chunkSize;
            
            wssAudio.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(chunk);
                }
            });
        }, 30);
    });
}
// Luồng Video (ESP-CAM -> Web)
wssVideo.on('connection', (ws) => {
    console.log("[Video] Có thiết bị vừa kết nối Camera, đang phát standingby.wav...");
    playSpecificSound('standingby.wav');
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
        }
        // Handle request to play a specific sound file
        else if (msg.startsWith('REQ_PLAY:')) {
            const filename = msg.split(':')[1];
            playSpecificSound(filename);
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
        socket.destroy(); // Chặn các kết nối rác
    }
});

server.listen(PORT, () => {
    console.log(`Server đang chạy tại Port ${PORT}`);
});