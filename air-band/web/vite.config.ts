import { defineConfig } from 'vite';

// 정적 호스팅(하위 경로 포함)에서도 동작하도록 상대 경로로 빌드
export default defineConfig({
  base: './',
  // 페이지 7개 (테니스 스윙 시각화 tennis.html 포함): 첫 화면(index.html) + 패드 · 녹음(pads.html) + 리듬 게임(rhythm.html) + 드럼 키트(kit.html) + TinyML(tinyml.html) + 지휘(conduct.html)
  build: {
    rollupOptions: { input: { main: 'index.html', pads: 'pads.html', rhythm: 'rhythm.html', kit: 'kit.html', tinyml: 'tinyml.html', conduct: 'conduct.html', tennis: 'tennis.html' } },
  },
  server: {
    // Web Bluetooth는 localhost 또는 HTTPS에서만 동작한다.
    // 폰에서 접속하는 방법은 README의 "폰에서 테스트" 항목 참고.
    port: 5173,
    // WSL에서 Windows 드라이브(/mnt/c)의 파일은 변경 알림이 오지 않아 수정해도 반영이 안 된다.
    // 폴링으로 감시하면 해결된다.
    watch: { usePolling: true, interval: 300 },
  },
});
