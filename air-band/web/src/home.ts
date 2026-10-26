// 첫 화면: 위 메뉴만 붙이고 각 페이지로 안내 (연결은 각 페이지에서)
import { mountHeader } from './ui/header';

// 예전 공유 링크(첫 화면 #take=...)는 패드 · 녹음 페이지로 넘긴다
if (location.hash.startsWith('#take=')) location.replace('pads.html' + location.hash);
mountHeader('home');
