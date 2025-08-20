// アプリケーションの初期化
document.addEventListener('DOMContentLoaded', function() {
    // サービスワーカー登録（オフライン対応）
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {
            // サービスワーカーなしでも動作
        });
    }
    
    // アップローダーを初期化
    window.uploader = new FileUploader();
    
    // エラーハンドリング
    window.addEventListener('error', function(e) {
        console.error('Application error:', e.error);
        showErrorMessage('予期しないエラーが発生しました。ページを再読み込みしてください。');
    });
    
    // 未対応ブラウザの警告
    if (!window.FileReader || !window.ArrayBuffer) {
        showErrorMessage('お使いのブラウザは対応していません。Chrome、Firefox、Safari、Edgeの最新版をご利用ください。');
    }
});

function showErrorMessage(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.innerHTML = `
        <div class="error-content">
            <h3>⚠️ エラー</h3>
            <p>${message}</p>
            <button onclick="this.parentElement.parentElement.remove()">閉じる</button>
        </div>
    `;
    document.body.appendChild(errorDiv);
}

// パフォーマンス監視
function trackPerformance(operation, startTime) {
    const endTime = performance.now();
    const duration = endTime - startTime;
    console.log(`${operation} completed in ${duration.toFixed(2)}ms`);
}

// ファイルサイズチェック
function validateFileSize(file, maxSizeMB = 100) {
    const maxSize = maxSizeMB * 1024 * 1024;
    if (file.size > maxSize) {
        throw new Error(`ファイルサイズが大きすぎます。${maxSizeMB}MB以下にしてください。`);
    }
    return true;
}

// H5ファイル検証
function validateH5File(file) {
    if (!file.name.toLowerCase().endsWith('.h5')) {
        throw new Error('H5ファイルを選択してください。');
    }
    
    validateFileSize(file, 50); // H5ファイルは50MB制限
    return true;
}

// 動画ファイル検証
function validateVideoFile(file) {
    if (!file.type.startsWith('video/')) {
        throw new Error('動画ファイルを選択してください。');
    }
    
    validateFileSize(file, 200); // 動画は200MB制限
    return true;
}
