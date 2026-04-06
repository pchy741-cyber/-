import { Storage } from '@google-cloud/storage';
import { logger } from '../utils/logger.js';

// ── GCS 설정 ──
const PROJECT_ID = 'quantops-trading';
const BUCKET_NAME = 'quantops-backups';
const LOCATION = 'asia-northeast3';

const storage = new Storage({ projectId: PROJECT_ID });

/**
 * 버킷이 없으면 자동 생성
 */
async function ensureBucket(): Promise<void> {
  try {
    const [exists] = await storage.bucket(BUCKET_NAME).exists();
    if (!exists) {
      await storage.createBucket(BUCKET_NAME, {
        location: LOCATION,
        storageClass: 'STANDARD',
      });
      logger.info(`GCS 버킷 생성 완료: ${BUCKET_NAME} (${LOCATION})`, {
        component: 'CLOUD_STORAGE',
      });
    }
  } catch (err: unknown) {
    // 409 = 이미 존재 (다른 프로세스가 동시에 생성한 경우)
    if (err instanceof Error && 'code' in err && (err as { code: number }).code === 409) {
      logger.info('GCS 버킷 이미 존재', { component: 'CLOUD_STORAGE' });
      return;
    }
    logger.error('GCS 버킷 생성 실패', { component: 'CLOUD_STORAGE', error: String(err) });
    throw err;
  }
}

/**
 * DB 백업/내보내기 파일을 GCS에 업로드
 * Path: backups/YYYY-MM-DD/{filename}
 */
export async function uploadBackup(data: string, filename: string): Promise<string> {
  await ensureBucket();

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const path = `backups/${today}/${filename}`;
  const file = storage.bucket(BUCKET_NAME).file(path);

  await file.save(data, { contentType: 'application/octet-stream' });

  logger.info(`백업 업로드 완료: gs://${BUCKET_NAME}/${path}`, {
    component: 'CLOUD_STORAGE',
  });
  return `gs://${BUCKET_NAME}/${path}`;
}

/**
 * 일일 매매 리포트를 GCS에 업로드
 * Path: reports/YYYY-MM/{date}.json
 */
export async function uploadTradeReport(report: string, date: string): Promise<string> {
  await ensureBucket();

  const yearMonth = date.slice(0, 7); // YYYY-MM
  const path = `reports/${yearMonth}/${date}.json`;
  const file = storage.bucket(BUCKET_NAME).file(path);

  await file.save(report, { contentType: 'application/json' });

  logger.info(`매매 리포트 업로드 완료: gs://${BUCKET_NAME}/${path}`, {
    component: 'CLOUD_STORAGE',
  });
  return `gs://${BUCKET_NAME}/${path}`;
}

/**
 * 스캘핑 패턴 이미지를 GCS에 업로드 후 공개 URL 반환
 * Path: patterns/{patternName}/{timestamp}.png
 */
export async function uploadScalpingImage(
  imageBuffer: Buffer,
  patternName: string,
): Promise<string> {
  await ensureBucket();

  const timestamp = Date.now();
  const path = `patterns/${patternName}/${timestamp}.png`;
  const file = storage.bucket(BUCKET_NAME).file(path);

  await file.save(imageBuffer, {
    contentType: 'image/png',
    metadata: { cacheControl: 'public, max-age=86400' },
  });

  // 공개 읽기 권한 부여
  await file.makePublic();

  const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${path}`;
  logger.info(`스캘핑 패턴 이미지 업로드 완료: ${publicUrl}`, {
    component: 'CLOUD_STORAGE',
  });
  return publicUrl;
}

/**
 * 최근 N일간의 백업 목록 조회
 */
export async function listBackups(days: number): Promise<string[]> {
  await ensureBucket();

  const [files] = await storage.bucket(BUCKET_NAME).getFiles({ prefix: 'backups/' });

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const recentBackups = files
    .filter((file) => {
      // backups/YYYY-MM-DD/filename 에서 날짜 추출
      const match = file.name.match(/^backups\/(\d{4}-\d{2}-\d{2})\//);
      if (!match) return false;
      return new Date(match[1]) >= cutoff;
    })
    .map((file) => file.name)
    .sort()
    .reverse();

  logger.info(`최근 ${days}일 백업 ${recentBackups.length}건 조회`, {
    component: 'CLOUD_STORAGE',
  });
  return recentBackups;
}
