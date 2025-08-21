class MultiHeaderCSVAnalyzer {
    constructor() {
        this.csvData = null;
        this.debugMode = true;
        this.structure = null;
        this.eps = 1e-9;
        
        // グローバルアクセス用
        window.lastAnalyzer = this;
    }

    /* ===================== public ===================== */

    async analyze(csvFile, videoFile, settings) {
        this.updateProgress(0, 'CSVファイル読み込み中...');
        
        try {
            const rawLines = await this.readCSVLines(csvFile);
            this.updateProgress(20, '多層ヘッダー解析中...');

            const parsedData = await this.parseMultiHeaderCSV(rawLines);
            this.updateProgress(40, '身体部位座標抽出中...');

            const coordinates = await this.extractCoordinatesFromParsedData(parsedData);
            this.updateProgress(60, 'Playfulness指標計算中...');

            const metrics = await this.performPlayfulnessAnalysis(coordinates, settings);
            this.updateProgress(80, '結果生成中...');

            const results = {
                metrics: metrics,
                metadata: {
                    filename: csvFile.name,
                    videoFilename: videoFile?.name,
                    settings: settings,
                    timestamp: new Date().toISOString(),
                    totalFrames: parsedData.numFrames,
                    individuals: parsedData.individuals,
                    bodyparts: parsedData.bodyparts,
                    dataPoints: metrics.length,
                    structure: this.structure
                }
            };
            
            this.updateProgress(100, '完了！');
            await new Promise(r => setTimeout(r, 200));
            return results;

        } catch (e) {
            this.log(`エラー: ${e.message}`);
            throw e;
        }
    }

    /* ===================== IO ===================== */

    async readCSVLines(file) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = e => {
                try {
                    const text = e.target.result;
                    const lines = text.split(/\r?\n/);
                    this.log(`CSV読み込み完了: ${lines.length}行`);
                    resolve(lines);
                } catch (err) { 
                    reject(err); 
                }
            };
            fr.onerror = () => reject(new Error('ファイル読み込みエラー'));
            fr.readAsText(file);
        });
    }

    safeSplit(line) {
        const out = [];
        let cur = '', inQ = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') inQ = !inQ;
            else if (ch === ',' && !inQ) { 
                out.push(cur); 
                cur = ''; 
            }
            else cur += ch;
        }
        out.push(cur);
        return out.map(s => s.trim().replace(/^"|"$/g, ''));
    }

    /* ===================== parser ===================== */

    async parseMultiHeaderCSV(lines) {
        // 先頭最大6行を候補として見る
        const head = [];
        for (let i = 0; i < Math.min(6, lines.length); i++) {
            head.push(this.safeSplit(lines[i]));
        }

        // coords 行の推定（ユニーク値が {x,y,likelihood} のみ）
        let coordRowIdx = -1;
        for (let r = 1; r < head.length; r++) {
            const uniq = new Set(head[r].map(s => s.toLowerCase()));
            const ok = [...uniq].every(v => v === '' || v === 'x' || v === 'y' || v === 'likelihood');
            if (ok) { 
                coordRowIdx = r; 
                break; 
            }
        }
        
        if (coordRowIdx === -1) {
            throw new Error('coordsヘッダ行（x,y,likelihood）が見つかりません');
        }

        const headerRows = head.slice(0, coordRowIdx + 1);
        const dataStart = coordRowIdx + 1;

        let scorerRow, individualRow = null, bodypartRow, coordRow;
        
        if (headerRows.length === 3) {
            [scorerRow, bodypartRow, coordRow] = headerRows;
        } else if (headerRows.length === 4) {
            [scorerRow, individualRow, bodypartRow, coordRow] = headerRows;
        } else {
            // 非典型：最初と最後を強引に割当
            scorerRow = headerRows[0];
            coordRow = headerRows.at(-1);
            bodypartRow = headerRows.length >= 3 ? headerRows.at(-2) : headerRows[0].map(() => '');
        }

        const hdrLen = Math.max(
            scorerRow.length, 
            bodypartRow.length, 
            coordRow.length, 
            individualRow?.length || 0
        );
        
        const scorer = this.padToLen(scorerRow, hdrLen);
        const individual = this.padToLen(individualRow || [], hdrLen);
        const bodypart = this.padToLen(bodypartRow, hdrLen);
        const coord = this.padToLen(coordRow, hdrLen);

        // メタ保存
        const dataLines = lines.slice(dataStart).filter(Boolean);
        this.structure = {
            scorer: [...new Set(scorer.filter(Boolean))][0] || scorer[0] || '',
            individuals: [...new Set(individual.filter(Boolean))],
            bodyparts: [...new Set(bodypart.filter(Boolean))],
            totalColumns: hdrLen,
            headerRows: headerRows.length
        };

        this.log(`ヘッダ行: ${headerRows.length}段 / カラム数=${hdrLen}`);
        this.log(`スコアラー: ${this.structure.scorer}`);
        this.log(`個体: ${this.structure.individuals.join(', ') || '(なし)'}`);
        this.log(`身体部位数: ${this.structure.bodyparts.length}`);
        this.log(`身体部位一覧: ${this.structure.bodyparts.join(', ')}`);

        return {
            numFrames: dataLines.length,
            individuals: this.structure.individuals,
            bodyparts: this.structure.bodyparts,
            headers: { scorer, individual, bodypart, coord },
            dataLines
        };
    }

    padToLen(arr, L) { 
        const a = arr.slice(); 
        while (a.length < L) a.push(''); 
        return a; 
    }

    /* ===================== coordinate extraction ===================== */

    async extractCoordinatesFromParsedData(parsed) {
        this.log('座標データを抽出中...');

        const { headers, dataLines } = parsed;
        const N = dataLines.length;

        // 各列のフィールド（individual/bodypart/coord）をまとめる
        const cols = [];
        for (let i = 0; i < headers.bodypart.length; i++) {
            cols.push({
                idx: i,
                individual: (headers.individual?.[i] || '').trim(),
                bodypart: (headers.bodypart?.[i] || '').trim(),
                coord: (headers.coord?.[i] || '').trim().toLowerCase()
            });
        }

        // 体部位→coord→列idx の辞書を作る（重複は最初を採用）
        const byPart = new Map();
        for (const c of cols) {
            if (!c.bodypart || !['x', 'y', 'likelihood'].includes(c.coord)) continue;
            const bp = c.bodypart;
            if (!byPart.has(bp)) byPart.set(bp, {});
            if (byPart.get(bp)[c.coord] == null) byPart.get(bp)[c.coord] = c.idx;
        }

        // すべてのbodypartについて配列準備
        const coordinates = {};
        const likelihood = {};
        const bpList = [...byPart.keys()];
        
        for (const bp of bpList) {
            coordinates[bp] = { x: new Array(N).fill(NaN), y: new Array(N).fill(NaN) };
            likelihood[bp] = new Array(N).fill(0);
        }

        // データ読み込み
        for (let r = 0; r < N; r++) {
            const vals = this.safeSplit(dataLines[r]);
            for (const bp of bpList) {
                const idxX = byPart.get(bp)?.x;
                const idxY = byPart.get(bp)?.y;
                const idxL = byPart.get(bp)?.likelihood;
                
                if (idxX != null) { 
                    const v = parseFloat(vals[idxX]); 
                    if (!Number.isNaN(v)) coordinates[bp].x[r] = v; 
                }
                if (idxY != null) { 
                    const v = parseFloat(vals[idxY]); 
                    if (!Number.isNaN(v)) coordinates[bp].y[r] = v; 
                }
                if (idxL != null) { 
                    const v = parseFloat(vals[idxL]); 
                    if (!Number.isNaN(v)) likelihood[bp][r] = v; 
                    else likelihood[bp][r] = 0; 
                }
                else { 
                    likelihood[bp][r] = 1.0; // likelihood列が無い場合は既定1
                }
            }
            
            if (r % 200 === 0) {
                const p = 40 + (r / N) * 20;
                this.updateProgress(p, `座標抽出中: ${r}/${N}`);
                await new Promise(res => setTimeout(res, 0));
            }
        }

        coordinates._likelihood = likelihood;
        coordinates._metadata = {
            numFrames: N,
            bodyparts: bpList,
            individuals: parsed.individuals
        };
        
        return coordinates;
    }

    /* ===================== playfulness ===================== */

    async performPlayfulnessAnalysis(coordinates, settings) {
        const { fps = 30, windowSec = 2.0, confidence = 0.5 } = settings || {};
        const win = Math.max(8, Math.round(windowSec * fps));
        const hop = Math.max(1, Math.round(0.5 * fps)); // 0.5秒ステップ

        const numFrames = coordinates._metadata.numFrames;
        const bodyparts = coordinates._metadata.bodyparts;

        // === 体部位マッピング（ゆれ吸収：正規表現） ===
        const map = this.mapRequiredBodypartsWithRegex(bodyparts);
        this.log(`身体部位マッピング結果:`);
        for (const [key, value] of Object.entries(map)) {
            this.log(`  ${key}: ${value || '❌見つからず'}`);
        }

        // === フレーム特徴量 ===
        const feat = await this.calculateFrameFeaturesV2(coordinates, map, confidence, fps);

        // === ウィンドウ集約 ===
        const metrics = [];
        for (let a = 0; a + win <= numFrames; a += hop) {
            const b = a + win;
            const seg = (arr) => arr.slice(a, b);
            
            const tailAngle = seg(feat.tailAngle);
            const tailBend = seg(feat.tailBend);
            const earForward = seg(feat.earForward);
            const angVel = seg(feat.angVel);
            const noseSpeed = seg(feat.noseSpeed);

            // 周波数解析
            const wag = this.dominantFreqHz(seg(feat.tailAngleInterp), fps);
            const wagFreq = wag.f || 0;
            const wagPower = wag.p || 0;

            // 特徴量統計
            const tailAngleMean = this.mean(tailAngle);
            const tailBendMean = this.mean(tailBend);
            const earForwardMean = this.mean(earForward);
            const angVelStd = this.std(angVel);
            const noseMovementMean = this.mean(noseSpeed);

            // 0–1正規化（パーセンタイル）
            const nz = v => v.filter(Number.isFinite);
            const pScale = (arr, lo = 5, hi = 95) => {
                const v = nz(arr).sort((x, y) => x - y);
                const q = p => v.length ? v[Math.min(v.length - 1, Math.max(0, Math.floor(p / 100 * (v.length - 1))))] : 0;
                const ql = q(lo), qh = q(hi);
                return arr.map(x => !Number.isFinite(x) ? 0 : (qh > ql ? Math.min(1, Math.max(0, (x - ql) / (qh - ql))) : 0));
            };

            const tailUpScore = this.inverseArr(pScale(tailAngle));     // 角が小さい＝上向き
            const earFwdScore = this.inverseArr(pScale(earForward));    // 小さい＝前向き
            const tailBendScore = pScale(tailBend);                     // 大きい＝曲げ大
            const agitationPen = this.mean(noseSpeed);                  // 全体の粗い活動（高いほど減点）

            // 周波数スコア（4Hz付近を最適とする）
            const wagPref = (Number.isFinite(wagFreq)) ? Math.exp(-0.5 * Math.pow((wagFreq - 4) / (1.5), 2)) : 0.5;

            // 合成（重み付きスコア）
            const w_tailUp = 0.35, w_ear = 0.35, w_bend = 0.25, w_wag = 0.10, w_ang = 0.15, w_agit = -0.20;
            const base = this.mean(tailUpScore) * w_tailUp
                + this.mean(earFwdScore) * w_ear
                + this.mean(tailBendScore) * w_bend
                + (Number.isFinite(wagPref) ? wagPref * w_wag : 0)
                + (Number.isFinite(angVelStd) ? (angVelStd / (this.eps + this.std(seg(feat.angVelAll)))) * w_ang : 0)
                + (Number.isFinite(agitationPen) ? (1 - Math.min(1, agitationPen / 30)) * w_agit : 0);

            // 📊 詳細メトリクス追加（新UIで表示される）
            metrics.push({
                timeCenter: (a + b) / (2 * fps),
                playIndex: Math.max(0, Math.min(1, base)),

                // 🎯 メイン特徴量（メーター表示用）
                tailAngleMean: tailAngleMean,           // 尻尾角度平均
                tailBendMean: tailBendMean,             // 尻尾曲げ角平均
                earForwardMean: earForwardMean,         // 耳前向き角度平均
                wagFreqHz: wagFreq,                     // 振り周波数
                wagPower: wagPower,                     // 振りパワー
                angVelStd: angVelStd,                   // 角速度変動
                noseMovement: noseMovementMean,         // 鼻の動き

                // 🔍 個別スコア（デバッグ用）
                tailUpScore: this.mean(tailUpScore),
                earForwardScore: this.mean(earFwdScore),
                tailBendScore: this.mean(tailBendScore),
                wagScore: wagPref,
                activityScore: Number.isFinite(angVelStd) ? Math.min(1, angVelStd / 50) : 0,

                // 📈 生データ統計（上級者向け）
                rawTailAngles: tailAngle.filter(v => !isNaN(v)),
                rawEarAngles: earForward.filter(v => !isNaN(v)),
                rawAngVel: angVel.filter(v => !isNaN(v))
            });

            // 進捗更新
            const progress = 60 + ((a / numFrames) * 20);
            this.updateProgress(progress, `解析中: ${Math.round((a / numFrames) * 100)}%`);
            
            if (a % (hop * 10) === 0) {
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        }

        this.log(`解析完了: ${metrics.length}個のデータポイント`);
        
        // 結果統計を表示
        if (metrics.length > 0) {
            const playIndices = metrics.map(m => m.playIndex);
            const min = Math.min(...playIndices);
            const max = Math.max(...playIndices);
            const mean = playIndices.reduce((a, b) => a + b) / playIndices.length;
            
            this.log(`Playfulness統計: min=${min.toFixed(3)}, max=${max.toFixed(3)}, mean=${mean.toFixed(3)}`);
            this.log(`変動あり: ${min !== max ? '✅' : '❌'}`);
        }
        
        return metrics;
    }

    mapRequiredBodypartsWithRegex(bodyparts) {
        // 代表名 → 正規表現（大小区別なし）
        const RX = {
            tail_base: /(tail[_\s-]?(base|root)|base[_\s-]?tail|tail0|tail_?0)/i,
            tail_end: /(tail[_\s-]?(tip|end)|tail\d+$|tail_?[1-9]|tailtip)/i,
            nose: /(nose|snout|muzzle)/i,
            neck_base: /(neck(_?base)?|withers|shoulder(_?center)?)/i,
            back_end: /(back[_\s-]?(end|base)|hip|pelvis|rump|sacrum|spine4)/i,
            back_middle: /(back[_\s-]?(mid|middle)|spine2|spine3|thorax|midback)/i,
            left_ear_base: /(left.*ear.*(base)?|ear.*left.*(base)?)/i,
            left_ear_end: /(left.*ear.*(tip|end)|ear.*left.*(tip|end))/i,
            right_ear_base: /(right.*ear.*(base)?|ear.*right.*(base)?)/i,
            right_ear_end: /(right.*ear.*(tip|end)|ear.*right.*(tip|end))/i
        };
        
        const norm = s => String(s || '');
        const pick = rx => bodyparts.find(bp => rx.test(norm(bp))) || null;
        const out = {};
        
        for (const k of Object.keys(RX)) {
            out[k] = pick(RX[k]);
        }
        
        return out;
    }

    async calculateFrameFeaturesV2(coor, map, pcut, fps) {
        const N = coor._metadata.numFrames;
        const L = coor._likelihood;
        const val = (bp, c, i) => (bp && coor[bp] ? coor[bp][c][i] : NaN);
        const likeOK = (bp, i) => (bp && L[bp] ? (L[bp][i] ?? 1) >= pcut : false);

        const tailAngle = new Array(N).fill(NaN);
        const tailBend = new Array(N).fill(NaN);
        const earForward = new Array(N).fill(NaN);
        const noseSpeed = new Array(N).fill(0);

        this.log('フレーム特徴量計算開始...');

        for (let i = 0; i < N; i++) {
            // しっぽ角（垂直との角度）
            if (likeOK(map.tail_base, i) && likeOK(map.tail_end, i)) {
                const vx = val(map.tail_end, 'x', i) - val(map.tail_base, 'x', i);
                const vy = val(map.tail_end, 'y', i) - val(map.tail_base, 'y', i);
                tailAngle[i] = this.angleDeg(0, -1, vx, vy); // 上=0°
            }

            // しっぽ曲げ角： back_end → tail_base → tail_end の外角
            if (likeOK(map.back_end, i) && likeOK(map.tail_base, i) && likeOK(map.tail_end, i)) {
                const bx = val(map.back_end, 'x', i), by = val(map.back_end, 'y', i);
                const tx = val(map.tail_base, 'x', i), ty = val(map.tail_base, 'y', i);
                const ex = val(map.tail_end, 'x', i), ey = val(map.tail_end, 'y', i);
                tailBend[i] = this.angleAt(bx, by, tx, ty, ex, ey);
            }

            // 耳の前向き度：頭軸（nose→neck）と左右耳ベクトル（base→end）との角の平均
            if (likeOK(map.nose, i) && (likeOK(map.neck_base, i) || likeOK(map.back_middle, i))) {
                const kx = likeOK(map.neck_base, i) ? val(map.neck_base, 'x', i) : val(map.back_middle, 'x', i);
                const ky = likeOK(map.neck_base, i) ? val(map.neck_base, 'y', i) : val(map.back_middle, 'y', i);
                const nx = val(map.nose, 'x', i), ny = val(map.nose, 'y', i);
                const hx = nx - kx, hy = ny - ky; // 頭→鼻

                const earAng = [];
                const Lset = [['left_ear_base', 'left_ear_end'], ['right_ear_base', 'right_ear_end']];
                for (const [eb, ee] of Lset) {
                    if (likeOK(map[eb], i) && likeOK(map[ee], i)) {
                        const ex = val(map[ee], 'x', i) - val(map[eb], 'x', i);
                        const ey = val(map[ee], 'y', i) - val(map[eb], 'y', i);
                        earAng.push(this.vecAngleDeg(hx, hy, ex, ey));
                    } else if (likeOK(map[eb], i)) {
                        // 先端が無ければ base→鼻 を代替
                        const ex = nx - val(map[eb], 'x', i);
                        const ey = ny - val(map[eb], 'y', i);
                        earAng.push(this.vecAngleDeg(hx, hy, ex, ey));
                    }
                }
                if (earAng.length) earForward[i] = earAng.reduce((a, b) => a + b, 0) / earAng.length; // 小さいほど前向き
            }

            // 鼻スピード（活動度の粗指標）
            if (i > 0 && likeOK(map.nose, i) && likeOK(map.nose, i - 1)) {
                const dx = val(map.nose, 'x', i) - val(map.nose, 'x', i - 1);
                const dy = val(map.nose, 'y', i) - val(map.nose, 'y', i - 1);
                noseSpeed[i] = Math.hypot(dx, dy);
            }

            // 進捗更新
            if (i % 100 === 0) {
                const progress = 60 + ((i / N) * 5);
                this.updateProgress(progress, `特徴量計算: ${i}/${N}`);
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        // 角速度
        const tailAngleInterp = this.interpNaN(tailAngle);
        const angVel = tailAngleInterp.map((v, i, arr) => i ? Math.abs(v - arr[i - 1]) * fps : 0);

        // 統計出力
        this.log('=== 特徴量統計 ===');
        const features = { tailAngle, tailBend, earForward, noseSpeed, angVel };
        for (const [name, values] of Object.entries(features)) {
            const valid = values.filter(Number.isFinite);
            if (valid.length > 0) {
                const min = Math.min(...valid);
                const max = Math.max(...valid);
                const mean = valid.reduce((a, b) => a + b) / valid.length;
                this.log(`${name}: 有効=${valid.length}/${values.length}, 範囲=${min.toFixed(2)}-${max.toFixed(2)}, 平均=${mean.toFixed(2)}`);
            } else {
                this.log(`${name}: 有効データなし`);
            }
        }

        return { tailAngle, tailAngleInterp, tailBend, earForward, angVel, angVelAll: angVel.slice(), noseSpeed };
    }

    /* ===================== math helpers ===================== */

    mean(a) { 
        const v = a.filter(Number.isFinite); 
        return v.length ? v.reduce((p, c) => p + c, 0) / v.length : 0; 
    }
    
    std(a) { 
        const v = a.filter(Number.isFinite); 
        if (v.length <= 1) return 0; 
        const m = this.mean(v); 
        return Math.sqrt(v.reduce((p, c) => p + (c - m) * (c - m), 0) / v.length); 
    }
    
    inverseArr(a) { 
        return a.map(v => 1 - (Number.isFinite(v) ? v : 0)); 
    }

    angleDeg(ax, ay, bx, by) { 
        // 2Dベクトルa,bの角度
        const a = Math.hypot(ax, ay), b = Math.hypot(bx, by);
        if (!a || !b) return NaN;
        const cos = ((ax * bx) + (ay * by)) / (a * b);
        return Math.acos(Math.min(1, Math.max(-1, cos))) * 180 / Math.PI;
    }
    
    vecAngleDeg(ax, ay, bx, by) { 
        return this.angleDeg(ax, ay, bx, by); 
    }
    
    angleAt(ax, ay, bx, by, cx, cy) { 
        // ∠ABC
        return this.vecAngleDeg(ax - bx, ay - by, cx - bx, cy - by);
    }
    
    interpNaN(arr) {
        const a = arr.slice();
        // 前方補間
        let last = null; 
        for (let i = 0; i < a.length; i++) { 
            if (Number.isFinite(a[i])) last = a[i]; 
            else if (last != null) a[i] = last; 
        }
        // 後方補間
        let next = null; 
        for (let i = a.length - 1; i >= 0; i--) { 
            if (Number.isFinite(a[i])) next = a[i]; 
            else if (next != null) a[i] = next; 
        }
        // 残りは0
        for (let i = 0; i < a.length; i++) {
            if (!Number.isFinite(a[i])) a[i] = 0;
        }
        return a;
    }
    
    dominantFreqHz(series, fps) {
        const x = this.interpNaN(series);
        const n = x.length;
        if (n < 8 || fps <= 0) return { f: NaN, p: NaN };
        
        // DC除去
        const m = this.mean(x); 
        for (let i = 0; i < n; i++) x[i] -= m;
        
        // 簡易DFT（最大ピーク）
        let bestF = NaN, bestP = -1;
        for (let k = 1; k <= Math.floor(n / 2); k++) {
            const f = k * fps / n;
            let re = 0, im = 0;
            for (let t = 0; t < n; t++) {
                const ang = -2 * Math.PI * k * t / n;
                re += x[t] * Math.cos(ang); 
                im += x[t] * Math.sin(ang);
            }
            const p = re * re + im * im;
            if (p > bestP) { 
                bestP = p; 
                bestF = f; 
            }
        }
        return { f: bestF, p: bestP };
    }

    /* ===================== logging/UI ===================== */

    log(msg) {
        console.log(`[MultiHeaderCSV] ${msg}`);
        const box = document.getElementById('debugInfo');
        if (box) { 
            box.innerHTML += `<div>${msg}</div>`; 
            box.scrollTop = box.scrollHeight; 
        }
    }
    
    updateProgress(percent, message) {
        const fill = document.getElementById('progressFill');
        const text = document.getElementById('progressText');
        if (fill) fill.style.width = percent + '%';
        if (text) text.textContent = message;
        
        const steps = ['step1', 'step2', 'step3', 'step4'];
        const cur = Math.floor(percent / 25);
        steps.forEach((id, idx) => { 
            const el = document.getElementById(id); 
            if (el && idx <= cur) el.classList.add('completed'); 
        });
    }
    
    /* ===================== feature display ===================== */
    
    updateFeatureDisplay(currentMetric) {
        if (!currentMetric) return;
        
        // 各特徴量の値と正規化された値を取得
        const features = {
            tailUp: {
                raw: currentMetric.tailAngleMean,
                score: currentMetric.tailUpScore,
                unit: '°',
                description: `角度: ${(currentMetric.tailAngleMean || 0).toFixed(1)}°`
            },
            earForward: {
                raw: currentMetric.earForwardMean,
                score: currentMetric.earForwardScore,
                unit: '°',
                description: `角度: ${(currentMetric.earForwardMean || 0).toFixed(1)}°`
            },
            tailBend: {
                raw: currentMetric.tailBendMean,
                score: currentMetric.tailBendScore,
                unit: '°',
                description: `角度: ${(currentMetric.tailBendMean || 0).toFixed(1)}°`
            },
            wagFreq: {
                raw: currentMetric.wagFreqHz,
                score: currentMetric.wagScore,
                unit: 'Hz',
                description: `周波数: ${(currentMetric.wagFreqHz || 0).toFixed(2)}Hz`
            },
            angVel: {
                raw: currentMetric.angVelStd,
                score: currentMetric.activityScore,
                unit: '°/s',
                description: `変動: ${(currentMetric.angVelStd || 0).toFixed(1)}°/s`
            }
        };
        
        // DOM要素を更新
        this.updateFeatureCard('tailUp', features.tailUp, '尻尾上がり度');
        this.updateFeatureCard('earForward', features.earForward, '耳前向き度');
        this.updateFeatureCard('tailBend', features.tailBend, '尻尾曲げ度');
        this.updateFeatureCard('wagFreq', features.wagFreq, '振り周波数');
        this.updateFeatureCard('angVel', features.angVel, '角速度運動');
        
        // 総合スコア
        const totalScore = currentMetric.playIndex;
        this.updateFeatureCard('totalPlay', {
            raw: totalScore,
            score: totalScore,
            unit: '',
            description: `総合指標: ${totalScore.toFixed(3)}`
        }, 'Playfulness');
    }
    
    updateFeatureCard(prefix, feature, label) {
        const valueEl = document.getElementById(`${prefix}Value`);
        const meterEl = document.getElementById(`${prefix}Meter`);
        
        if (valueEl) {
            if (feature.unit === '') {
                valueEl.textContent = feature.score.toFixed(3);
            } else {
                valueEl.textContent = `${feature.raw.toFixed(2)}${feature.unit}`;
            }
        }
        
        if (meterEl) {
            const percentage = Math.max(0, Math.min(100, feature.score * 100));
            meterEl.style.width = `${percentage}%`;
            
            // スコアに応じて色を調整
            if (prefix === 'wagFreq') {
                // 周波数は4Hz付近が最適なので特別処理
                const optimal = Math.exp(-0.5 * Math.pow((feature.raw - 4) / 1.5, 2));
                meterEl.style.width = `${optimal * 100}%`;
            }
        }
    }
    
    /* ===================== chart interaction ===================== */
    
    setupChartClickHandler(chart, metrics) {
        if (!chart || !metrics) return;
        
        chart.options.onClick = (event, elements) => {
            if (elements.length > 0) {
                const dataIndex = elements[0].index;
                const currentMetric = metrics[dataIndex];
                if (currentMetric) {
                    this.updateFeatureDisplay(currentMetric);
                    
                    // 時刻表示も更新
                    const timeEl = document.getElementById('currentTime');
                    if (timeEl) {
                        timeEl.textContent = currentMetric.timeCenter.toFixed(1);
                    }
                    
                    // ビデオシークも実行
                    const video = document.getElementById('resultVideo');
                    if (video && !isNaN(currentMetric.timeCenter)) {
                        video.currentTime = currentMetric.timeCenter;
                    }
                }
            }
        };
        
        // マウスホバーでも特徴量表示を更新
        chart.options.onHover = (event, elements) => {
            if (elements.length > 0) {
                const dataIndex = elements[0].index;
                const currentMetric = metrics[dataIndex];
                if (currentMetric) {
                    this.updateFeatureDisplay(currentMetric);
                }
            }
        };
        
        chart.update();
    }
}
