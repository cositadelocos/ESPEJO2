// ========================================
// MOTOR GRÁFICO DEL POLVO (PIXIJS)
// ========================================

const DustSystem = {
    // Variables
    app: null,
    maskCanvas: null,
    maskCtx: null,
    maskTexture: null,
    dustSprite: null,
    dustFilter: null,
    
    // Configuración
    CONFIG: {
        MASK_SIZE: 512,
        DUST_FADE_RATE: 0.0008,
        MIN_BRUSH_RADIUS: 0.025, // Bajado para ser un poco más pequeño
        MAX_BRUSH_RADIUS: 0.05, // Bajado para ser un poco más pequeño
        WRIST_MULTIPLIER: 1.5, // Menor área alrededor de la muñeca
        VISIBILITY_THRESHOLD: 0.5,
        FIRST_CONTACT_FRAMES: 3,
        TRAIL_STEPS: 6,
        CLEAN_THRESHOLD: 0.80 // Reducido a 80%
    },
    
    // Estado
    isFinished: false,
    cleanPercentage: 0,
    renderFrameCount: 0,
    playedInicioAudio: false,
    playedHistoriaAudio: false,
    wristState: {
        left: { prev: null, visible: false, firstContact: 0 },
        right: { prev: null, visible: false, firstContact: 0 }
    },
    
    // Inicialización
    init: async function(containerId, onCleanedCallback) {
        this.onCleaned = onCleanedCallback;
        const container = document.getElementById(containerId);
        if (!container) return;
        
        // Crear aplicación PixiJS con fondo transparente (para ver el video HTML debajo)
        this.app = new PIXI.Application({
            resizeTo: window,
            backgroundAlpha: 0,
            antialias: true,
            resolution: window.devicePixelRatio || 1,
            autoDensity: true,
        });
        
        container.appendChild(this.app.view);
        
        // Canvas offscreen para la máscara en blanco y negro (comienza negra = polvorienta)
        this.maskCanvas = document.createElement('canvas');
        this.maskCanvas.width = this.CONFIG.MASK_SIZE;
        this.maskCanvas.height = this.CONFIG.MASK_SIZE;
        this.maskCtx = this.maskCanvas.getContext('2d');
        this.maskCtx.fillStyle = 'black';
        this.maskCtx.fillRect(0, 0, this.CONFIG.MASK_SIZE, this.CONFIG.MASK_SIZE);
        
        this.maskTexture = PIXI.Texture.from(this.maskCanvas);
        
        // Crear textura procedural
        const dustTexture = this.createDustTexture();
        this.dustSprite = new PIXI.Sprite(dustTexture);
        this.dustSprite.width = window.innerWidth;
        this.dustSprite.height = window.innerHeight;
        this.dustSprite.x = 0;
        this.dustSprite.y = 0;
        
        // Shader para combinar máscara y polvo
        this.dustFilter = new PIXI.Filter(null, `
            precision mediump float;
            varying vec2 vTextureCoord;
            uniform sampler2D uSampler;
            uniform sampler2D cleanMask;

            void main() {
                vec4 dust = texture2D(uSampler, vTextureCoord);
                float cleaned = texture2D(cleanMask, vTextureCoord).r;

                // Áreas limpias (blancas en la máscara) reducen el alpha del polvo
                dust.a = dust.a * (1.0 - cleaned);
                gl_FragColor = dust;
            }
        `, {
            cleanMask: this.maskTexture,
        });
        
        this.dustSprite.filters = [this.dustFilter];
        this.app.stage.addChild(this.dustSprite);
        
        // Manejo de Resize
        window.addEventListener('resize', () => {
            if (this.dustSprite) {
                this.dustSprite.width = window.innerWidth;
                this.dustSprite.height = window.innerHeight;
            }
        });
        
        // Render Loop
        this.app.ticker.add(() => this.renderLoop());
        
        console.log("🌪️ Sistema de Polvo Inicializado");
    },
    
    // Crear la textura simulando polvo
    createDustTexture: function() {
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');

        ctx.clearRect(0, 0, 1280, 720);

        // Base marrón claro semitransparente
        ctx.fillStyle = 'rgba(210, 180, 140, 0.8)';
        ctx.fillRect(0, 0, 1280, 720);

        // Efecto ruido
        const noiseCanvas = document.createElement('canvas');
        noiseCanvas.width = 200;
        noiseCanvas.height = 200;
        const noiseCtx = noiseCanvas.getContext('2d');
        for (let i = 0; i < 200; i++) {
            for (let j = 0; j < 200; j++) {
                const gray = Math.floor(Math.random() * 50 + 100);
                noiseCtx.fillStyle = `rgba(${gray}, ${gray}, ${gray}, 0.3)`;
                noiseCtx.fillRect(i, j, 1, 1);
            }
        }

        const pattern = ctx.createPattern(noiseCanvas, 'repeat');
        ctx.fillStyle = pattern;
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillRect(0, 0, 1280, 720);

        // Motas de polvo oscuras
        ctx.globalCompositeOperation = 'source-over';
        for (let i = 0; i < 500; i++) {
            const x = Math.random() * 1280;
            const y = Math.random() * 720;
            const size = Math.random() * 3 + 1;
            const opacity = Math.random() * 0.3 + 0.1;

            ctx.beginPath();
            ctx.arc(x, y, size, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(139, 119, 75, ${opacity})`;
            ctx.fill();
        }

        return PIXI.Texture.from(canvas);
    },
    
    // Procesa los puntos de MediaPipe (Centro en la punta de la mano/dedos)
    processLandmarks: function(landmarks) {
        if (this.isFinished || !this.app) return;
        
        // Puntos de la mano izquierda
        const leftWrist = landmarks[15];
        const leftIndex = landmarks[19]; // Punta índice izquierdo
        // Usar índice para limpiar, pero wrist para calcular radio (distancia)
        this.processHand(leftIndex || leftWrist, leftWrist, 'left');
        
        // Puntos de la mano derecha
        const rightWrist = landmarks[16];
        const rightIndex = landmarks[20]; // Punta índice derecho
        this.processHand(rightIndex || rightWrist, rightWrist, 'right');
    },
    
    processHand: function(handCenter, wrist, side) {
        if (!handCenter || !wrist || handCenter.visibility < this.CONFIG.VISIBILITY_THRESHOLD) {
            this.wristState[side].visible = false;
            this.wristState[side].firstContact = 0;
            return;
        }

        if (!this.wristState[side].visible) {
            this.wristState[side].firstContact = this.CONFIG.FIRST_CONTACT_FRAMES;
        }
        this.wristState[side].visible = true;

        // Calcular radio con base en la distancia del centro al wrist (para tener una referencia de tamaño)
        const dx = handCenter.x - wrist.x;
        const dy = handCenter.y - wrist.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        let radiusUV = distance * this.CONFIG.WRIST_MULTIPLIER;

        radiusUV = Math.max(this.CONFIG.MIN_BRUSH_RADIUS, Math.min(this.CONFIG.MAX_BRUSH_RADIUS, radiusUV));

        if (this.wristState[side].firstContact > 0) {
            radiusUV *= 2; // Brocha más ancha inicial
            this.wristState[side].firstContact--;
        }

        // Espejado usando el centro de la mano (índice)
        const wristX = (1.0 - handCenter.x) * this.CONFIG.MASK_SIZE; 
        const wristY = handCenter.y * this.CONFIG.MASK_SIZE;
        const radiusPx = radiusUV * this.CONFIG.MASK_SIZE;

        const prev = this.wristState[side].prev;
        if (prev) {
            this.drawWristTrail(prev.x, prev.y, wristX, wristY, radiusPx);
        }

        this.drawSoftCircle(this.maskCtx, wristX, wristY, radiusPx);
        this.wristState[side].prev = { x: wristX, y: wristY };
    },
    
    drawWristTrail: function(x1, y1, x2, y2, radius) {
        for (let i = 0; i <= this.CONFIG.TRAIL_STEPS; i++) {
            const t = i / this.CONFIG.TRAIL_STEPS;
            const ix = x1 + (x2 - x1) * t;
            const iy = y1 + (y2 - y1) * t;
            this.drawSoftCircle(this.maskCtx, ix, iy, radius);
        }
    },

    drawSoftCircle: function(ctx, x, y, radius) {
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
        gradient.addColorStop(0.6, 'rgba(255, 255, 255, 0.8)');
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0.0)');

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    },
    
    renderLoop: function() {
        if (!this.isFinished) {
            // Re-acumulación de polvo progresiva
            this.maskCtx.fillStyle = `rgba(0, 0, 0, ${this.CONFIG.DUST_FADE_RATE})`;
            this.maskCtx.fillRect(0, 0, this.CONFIG.MASK_SIZE, this.CONFIG.MASK_SIZE);

            this.renderFrameCount++;
            if (this.renderFrameCount % 30 === 0) {
                this.checkCleanliness();
            }
        } else {
            // Animación de desvanecimiento
            if (this.dustSprite && this.dustSprite.alpha > 0) {
                this.dustSprite.alpha -= 0.02;
                if (this.dustSprite.alpha <= 0) {
                    this.dustSprite.alpha = 0;
                    this.dustSprite.visible = false;
                }
            }
        }

        if (this.maskTexture) this.maskTexture.update();
    },
    
    checkCleanliness: function() {
        const imgData = this.maskCtx.getImageData(0, 0, this.CONFIG.MASK_SIZE, this.CONFIG.MASK_SIZE).data;
        let cleanPixels = 0;
        let totalSamples = 0;

        for (let i = 0; i < imgData.length; i += 64) {
            if (imgData[i] > 128) { // Canal rojo
                cleanPixels++;
            }
            totalSamples++;
        }

        this.cleanPercentage = cleanPixels / totalSamples;
        
        if (this.cleanPercentage > 0.09 && !this.playedInicioAudio) {
            this.playedInicioAudio = true; // Set block flag first
            const audioInicio = document.getElementById('audio-inicio');
            if (audioInicio) {
                // Forzamos currentTime a 0 por si a caso
                audioInicio.currentTime = 0;
                let playPromise = audioInicio.play();
                
                // Función auxiliar para continuar con "historia"
                const continuarConHistoria = () => {
                    setTimeout(() => {
                        const audioHistoria = document.getElementById('audio-historia');
                        if (audioHistoria && !this.playedHistoriaAudio) {
                            this.playedHistoriaAudio = true;
                            audioHistoria.currentTime = 0;
                            audioHistoria.play().catch(e => console.log('Audio historia bloqueado', e));
                            
                            // Una vez termine "historia.wav", 1 segundo despues el espejo se limpia automático
                            audioHistoria.onended = () => {
                                setTimeout(() => {
                                    if (!this.isFinished) {
                                        this.forzarLimpiezaTotal();
                                    }
                                }, 1000);
                            };
                            
                            // Respaldo por si onended falla o no dispara (asumiendo que historia no supera los ~30 seg, pero lo mejor es el listener puro)
                        }
                    }, 1000); // <-- 1 segundo de pausa entre audios
                };

                if (playPromise !== undefined) {
                    playPromise.then(() => {
                        // Reproduciendo correctamente
                        audioInicio.onended = continuarConHistoria;
                    }).catch(e => {
                        console.log('Audio inicio bloqueado o error', e);
                        // Si falla, pasamos directo a intentar historia como fallback
                        continuarConHistoria();
                    });
                } else {
                    // Navegadores viejos donde play() no devuelve promise
                    audioInicio.onended = continuarConHistoria;
                }
            }
        }

        if (this.cleanPercentage > this.CONFIG.CLEAN_THRESHOLD) {
            this.isFinished = true;
            if (this.onCleaned) this.onCleaned();
        }
    },

    forzarLimpiezaTotal: function() {
        this.cleanPercentage = 1.0;
        this.maskCtx.fillStyle = 'white';
        this.maskCtx.fillRect(0, 0, this.CONFIG.MASK_SIZE, this.CONFIG.MASK_SIZE);
        if (this.maskTexture) this.maskTexture.update();
        this.isFinished = true;
        if (this.onCleaned) this.onCleaned();
    },

    // Para cuando queramos re-ensuciar el espejo para la siguiente persona
    resetDust: function() {
        if (!this.maskCtx) return;
        this.isFinished = false;
        this.cleanPercentage = 0;
        this.playedInicioAudio = false;
        this.playedHistoriaAudio = false;
        this.maskCtx.fillStyle = 'black';
        this.maskCtx.fillRect(0, 0, this.CONFIG.MASK_SIZE, this.CONFIG.MASK_SIZE);
        
        if (this.dustSprite) {
            this.dustSprite.alpha = 1;
            this.dustSprite.visible = true;
        }
        
        this.wristState.left.prev = null;
        this.wristState.left.visible = false;
        this.wristState.right.prev = null;
        this.wristState.right.visible = false;
        
        console.log("🌪️ Polvo reseteado.");
    }
};
