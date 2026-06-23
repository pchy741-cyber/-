# 노트북(pchy741) 충돌 없이 최신버전 받는 방법

## 집에서 작업 시작할 때 (노트북 켜면 제일 먼저)

```powershell
cd C:\Users\pchy741\.cursor\projects\quantops   # 또는 실제 클론 경로

# 1. 로컬에 수정한 게 없으면 그냥:
git pull origin main

# 2. 로컬에 수정한 게 있으면:
git stash          # 내 변경사항 임시 저장
git pull origin main
git stash pop      # 다시 꺼내기 (충돌 나면 아래 충돌 해결 참고)
```

---

## 작업 중 변경사항 저장할 때

```powershell
git add -A
git commit -m "작업 내용 간단히"
git push origin main
```

---

## 충돌 났을 때 (stash pop 후 CONFLICT 메시지 뜨면)

```powershell
# 어떤 파일이 충돌인지 확인
git status

# VS Code로 충돌 파일 열어서 <<<< ==== >>>> 마커 직접 수정
# 수정 후:
git add 충돌파일
git commit -m "merge: resolve conflict"
git push origin main
```

> 충돌이 복잡하면 내 변경사항을 버리고 서버 최신으로 덮어쓰기:
> ```powershell
> git checkout -- 파일명   # 특정 파일만
> # 또는 전체 리셋 (주의: 내 수정 전부 사라짐)
> git reset --hard origin/main
> ```

---

## 처음 노트북에 클론할 때 (최초 1회)

```powershell
git clone https://github.com/pchy741-cyber/quantops-trading.git
cd quantops-trading
npm install
cp .env.example .env   # 환경변수 설정 필요
```

---

## 환경변수 (.env) 주의사항

`.env` 파일은 git에 포함 안 됨 → 노트북에서 직접 생성해야 함.  
필수 변수는 `.env.example` 또는 Cloud Run 시크릿 참조.

---

## 자주 쓰는 명령어 요약

| 상황 | 명령어 |
|------|--------|
| 최신버전 받기 (수정 없을 때) | `git pull origin main` |
| 내 수정 임시저장 후 받기 | `git stash && git pull origin main && git stash pop` |
| 내 수정 올리기 | `git add -A && git commit -m "설명" && git push origin main` |
| 현재 상태 확인 | `git status` |
| 서버 최신으로 강제 리셋 | `git reset --hard origin/main` (주의: 로컬 수정 삭제) |
