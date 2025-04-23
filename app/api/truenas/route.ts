import { NextRequest, NextResponse } from 'next/server';
import supabase from '@/lib/supabaseClient'; // Supabaseクライアントをインポート

// --- TypeScript Interfaces for Payloads ---
interface TrueNASUserPayload {
  username: string;
  password?: string; // パスワードはオプションの場合もあるのでAPI仕様を確認
  full_name: string;
  home: string; // 例: /mnt/tank/users/username
  shell?: string; // 例: /bin/bash or /usr/sbin/nologin
  group_create?: boolean;
  // uid は省略
}

interface TrueNASDatasetPayload {
  name: string; // 例: tank/users/username
  type?: 'FILESYSTEM';
  quota?: number; // バイト単位
  // inherit_encryption?: boolean; など他のオプションも確認
}

interface TrueNASAce {
  tag: 'USER' | 'GROUP' | string; // USER が主
  id: string; // username or groupname (Python版はidにusernameを指定) ※ API仕様によっては uid/gid が必要な場合も
  type: 'ALLOW' | 'DENY';
  perms: { [key: string]: boolean }; // 例: { read: true, write: true, ... }
  flags: { [key: string]: boolean }; // 例: { file_inherit: true, dir_inherit: true }
}

interface TrueNASSetAclPayload {
  path: string; // 例: /mnt/tank/users/username
  dacl: boolean;
  aces: TrueNASAce[];
}

// --- Constants ---
const ONE_GB_IN_BYTES = 1024 * 1024 * 1024;
const QUOTA_TIER_100GB = 100 * ONE_GB_IN_BYTES;
const QUOTA_TIER_500GB = 500 * ONE_GB_IN_BYTES;
const QUOTA_TIER_1TB = 1024 * ONE_GB_IN_BYTES;
const POOL_NAME = process.env.POOL_NAME || 'tank'; // 環境変数からプール名取得、なければ 'tank'

// Helper function for API calls
async function fetchTrueNASAPI(
  url: string,
  method: string,
  apiKey: string,
  body?: TrueNASUserPayload | TrueNASDatasetPayload | TrueNASSetAclPayload | Record<string, unknown>
) {
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  console.log(`Calling TrueNAS API: ${method} ${url}`);
  if (body) console.log('Payload:', JSON.stringify(body, null, 2)); // デバッグ用

  const response = await fetch(url, {
    method: method,
    headers: headers,
    body: body ? JSON.stringify(body) : undefined,
    // SSL検証に関するオプションが必要な場合はここに追加 (node-fetchなど)
    // Next.js の fetch は Node の fetch に準拠。Node 18以降は `rejectUnauthorized` を直接は指定できない。
    // 必要なら https.Agent を使うか、環境変数 NODE_TLS_REJECT_UNAUTHORIZED=0 (非推奨) を使う。
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`TrueNAS API Error (${response.status}): ${errorText}`);
    throw new Error(`TrueNAS API request failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  // ボディがない、または Content-Type が JSON でない場合があるため try-catch
  try {
    // ステータスコード 204 (No Content) など、ボディがない場合を考慮
    if (response.status === 204 || response.headers.get('content-length') === '0') {
        console.log('TrueNAS API Response: No content.');
        return null;
    }
    // Content-Type が application/json でない場合も考慮 (より厳密にするなら)
    if (!response.headers.get('content-type')?.includes('application/json')) {
        console.log('TrueNAS API Response: Not JSON.');
        return await response.text(); // テキストとして返すか、null を返すかなど検討
    }
    const responseData = await response.json();
    console.log('TrueNAS API Response:', responseData);
    return responseData;
  } catch (e) {
    // JSON解析エラーの場合 'e' をログに出力
    console.error('Error parsing JSON response:', e);
    throw new Error('Failed to parse TrueNAS API JSON response.'); // 新しいエラーをスロー
  }
}

export async function POST(request: NextRequest) {
  let datasetCreated = false;
  let supabaseLogged = false;
  let userCreated = false;
  let aclSet = false;

  try {
    const formData = await request.json();
    const { name, password, usageType, storageQuota } = formData;

    if (!name || !password || !usageType || (usageType === 'personal' && (typeof storageQuota !== 'number' || storageQuota <= 0))) {
      return NextResponse.json({ message: 'Invalid input data' }, { status: 400 });
    }

    const truenasUrl = process.env.TRUENAS_URL;
    const truenasApiKey = process.env.API_TOKEN;

    if (!truenasUrl || !truenasApiKey) {
      console.error('TrueNAS API URL or Token is not configured.');
      return NextResponse.json({ message: 'Server configuration error' }, { status: 500 });
    }

    console.log('Processing request for user:', name, 'Usage type:', usageType);

    let homeDirectoryPath: string | undefined = undefined;
    let poolNameToUse: string | undefined = undefined;

    // --- Personal 利用の場合: プール決定とデータセット作成 ---
    if (usageType === 'personal') {
        console.log('Personal usage: Determining pool and creating dataset.');

        // storageQuota の再検証
        if (typeof storageQuota !== 'number' || storageQuota <= 0) {
            return NextResponse.json({ message: 'Invalid storage quota for personal usage' }, { status: 400 });
        }

        // --- プール名とクォータの決定 ---
        let quotaInBytes: number | undefined;
        if (storageQuota <= 100) {
            poolNameToUse = 'student-50-100'; // <= 100GB は student-50-100 プールに変更
            quotaInBytes = QUOTA_TIER_100GB; // クォータは100GBのまま
        } else if (storageQuota <= 500) {
            poolNameToUse = 'student-500';
            quotaInBytes = QUOTA_TIER_500GB;
        } else if (storageQuota <= 1024) {
            poolNameToUse = 'student-1000';
            quotaInBytes = QUOTA_TIER_1TB;
        } else {
            poolNameToUse = 'student-1000'; // 1TB超も student-1000 (要件確認)
            quotaInBytes = QUOTA_TIER_1TB;   // 1TB超のクォータ (要件確認)
            console.warn(`Requested quota ${storageQuota}GB exceeds 1TB. Assigning to pool ${poolNameToUse} with quota ${quotaInBytes}. Review policy.`);
        }
        console.log(`Storage quota ${storageQuota}GB maps to Pool: ${poolNameToUse}, Quota Bytes: ${quotaInBytes}`);

        if (!poolNameToUse) {
            throw new Error(`Could not determine pool name for quota ${storageQuota}GB.`);
        }

        const datasetPath = `${poolNameToUse}/users/${name}`;
        const datasetMountPath = `/mnt/${datasetPath}`;
        homeDirectoryPath = datasetMountPath;

        // --- 1a. データセット作成 (親データセット存在確認は未実装) ---
        // TODO: 親データセット (e.g., student-50-100/users) の存在確認と作成ロジックを追加
        const datasetPayload: TrueNASDatasetPayload = { name: datasetPath, type: 'FILESYSTEM', quota: quotaInBytes };
        const datasetCreateUrl = `${truenasUrl}/api/v2.0/pool/dataset`;
        try {
             await fetchTrueNASAPI(datasetCreateUrl, 'POST', truenasApiKey, datasetPayload);
             console.log(`TrueNAS dataset ${datasetPath} created successfully.`);
             datasetCreated = true;
        } catch (error: unknown) {
             console.error('Failed to create dataset, aborting user creation.', error);
             // unknown 型なので、アクセス前に型ガードが必要
             const errorMsg = error instanceof Error ? error.message : String(error);
             if (errorMsg.includes("Parent dataset does not exist")) {
                 // 親データセットが存在しない場合のエラーをスロー
                 throw new Error(`Parent dataset for ${datasetPath} does not exist. Please create it first.`);
             }
             // その他のデータセット作成エラー
             if (error instanceof Error) {
                 throw new Error(`Failed to create prerequisite dataset ${datasetPath}. User not created. Original error: ${error.message}`);
             } else {
                 throw new Error(`Failed to create prerequisite dataset ${datasetPath}. User not created. Unknown error: ${String(error)}`);
             }
        }
    }

    // --- 2. TrueNAS ユーザー作成 ---
    const userPayload: TrueNASUserPayload = {
      username: name,
      password: password,
      full_name: name, // full_name に username を設定
      home: homeDirectoryPath || `/mnt/${POOL_NAME}/users/${name}`, // personal 用のパスを設定 (projectでも設定はするがデータセットは作らない)
      shell: '/usr/sbin/nologin', // SSHさせない場合は nologin が安全
      group_create: true, // ユーザーと同名のプライベートグループを作成
    };
    if (homeDirectoryPath) { userPayload.home = homeDirectoryPath; }
    const userCreateUrl = `${truenasUrl}/api/v2.0/user`;
    await fetchTrueNASAPI(userCreateUrl, 'POST', truenasApiKey, userPayload);
    console.log(`TrueNAS user ${name} created successfully.`);
    userCreated = true;


    // --- 3. Personal 利用の場合: ACL設定 ---
    if (usageType === 'personal' && datasetCreated && userCreated && poolNameToUse) {
        const datasetMountPath = `/mnt/${poolNameToUse}/users/${name}`; // Correct path
        const aclPayload: TrueNASSetAclPayload = { path: datasetMountPath, dacl: true, aces: [
          {
            tag: 'USER',
            id: name, // Python版に合わせて username を使用 (API仕様確認)
            type: 'ALLOW',
            perms: { // Python版のパーミッションを参考に設定
              BASIC_READ: true, // より標準的なパーミッション名を使用 (要API確認)
              BASIC_WRITE: true,
              BASIC_EXECUTE: true,
              DELETE_CHILD: true,
              DELETE_SELF: true, // delete / delete_child を BASIC_* や MODIFY に置き換えられるか確認
              // 以下は BASIC や MODIFY に含まれることが多いので、よりシンプルな指定が可能か確認
              // "read": true, "write": true, "execute": true, "delete": true,
              // "delete_child": true, "list": true, "add_file": true, "add_subdirectory": true
            },
            flags: { // 継承設定
              FILE_INHERIT: true,
              DIRECTORY_INHERIT: true,
              NO_PROPAGATE_INHERIT: false, // 通常は False
              INHERIT_ONLY: false, // 通常は False
            }
          },
          // 必要に応じて他のACE (例: 所有者グループ、@everyoneなど) を追加
        ] };
        const aclSetUrl = `${truenasUrl}/api/v2.0/filesystem/setacl`;
        await fetchTrueNASAPI(aclSetUrl, 'POST', truenasApiKey, aclPayload);
        console.log(`ACL set successfully for ${datasetMountPath}`);
        aclSet = true;
    } else if (usageType === 'project' && userCreated) {
        // --- 4. Project 利用の場合: Supabaseにログ保存 ---
        console.log('Project usage: Saving data to Supabase.');
        const { error: supabaseError } = await supabase
          .from('project_requests') // テーブル名を確認
          .insert({
            user_name: name,
            requested_quota_gb: storageQuota || null,
            // password は保存しない
            created_at: new Date(),
          });

        if (supabaseError) {
          console.error('Error saving to Supabase:', supabaseError);
          // エラーにするか警告に留めるかは要件次第
          throw new Error(`Failed to save project request to Supabase: ${supabaseError.message}`);
        }
        console.log(`Project request for user ${name} saved to Supabase.`);
        supabaseLogged = true;
    }

    // --- 処理成功 ---
    let successMessage = `TrueNAS user ${name} created successfully.`;
    if (datasetCreated && aclSet) {
      successMessage += ` Personal dataset created in pool ${poolNameToUse} and ACL configured.`;
    } else if (supabaseLogged) {
      successMessage += ' Project request logged to Supabase.';
    }
    return NextResponse.json({ message: successMessage }, { status: 200 });

  } catch (error) {
    console.error('Error processing request:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    // エラーレスポンスには詳細なエラー（スタックトレースなど）を含めない方が安全
    return NextResponse.json({ message: 'Failed to process request', error: errorMessage }, { status: 500 });
  }
} 