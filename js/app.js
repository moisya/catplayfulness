// アプリケーションの初期化
document.addEventListener('DOMContentLoaded', function() {
    // サービスワーカー登録をコメントアウト
    /*
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {
            console.log('Service Worker registration failed');
        });
    }
    */
    
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
