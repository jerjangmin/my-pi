# Lessons

- Pi 내부 모듈을 참조하는 확장은 `/usr/local` 같은 전역 설치 경로를 고정하지 말고, 현재 실행 중인 Pi 엔트리포인트에서 패키지 루트를 해석해야 한다.
- 확장 런타임 의존성을 `package.json`에 선언한 것만으로 충분하지 않다. 배포·설치 후 실제 확장 디렉터리의 `node_modules` 존재 여부를 로딩 검증으로 확인한다.
- 실행 중인 Pi의 설정 루트에 `rsync --delete`를 적용하면 열린 세션 파일까지 사라질 수 있다. 교체 전 `sessions/`, `auth.json`, `state/` 등 런타임 경로를 제외하거나, 외부 백업에서 `--ignore-existing`으로 먼저 복원한 뒤 검증한다.
- 사용자가 완료 후 todo 정리를 요청하면 최종 push·원격 검증까지 마친 다음 `tasks/todo.md`를 제거한다.
