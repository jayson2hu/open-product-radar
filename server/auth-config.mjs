export function getAuthConfiguration(options, mode, publicUrl) {
  const clientId=options.githubClientId??process.env.GITHUB_CLIENT_ID;
  const clientSecret=options.githubClientSecret??process.env.GITHUB_CLIENT_SECRET;
  let securePublicOrigin=false;
  try {const url=new URL(publicUrl);securePublicOrigin=url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&['','/'].includes(url.pathname);}catch{}
  const githubEnabled=mode==='production'&&!!clientId&&!!clientSecret&&securePublicOrigin;
  const configuredIds=options.adminGithubIds??(process.env.RADAR_ADMIN_GITHUB_IDS||'').split(',');
  const adminGithubIds=new Set(configuredIds.map(id=>String(id).trim()).filter(id=>/^\d+$/.test(id)));
  return {clientId,clientSecret,githubEnabled,adminGithubIds,
    publicCapabilities(local){const demoEnabled=mode==='demo'&&local;return {auth:{github_enabled:githubEnabled,demo_enabled:demoEnabled,login_available:githubEnabled||demoEnabled,
      ...(!githubEnabled&&!demoEnabled?{unavailable_reason:mode==='production'?'GitHub 登录尚未配置完成；当前可浏览公开研究资料。':'演示登录仅供本机访问使用。'}:{})},
      collection_scope:{kind:'curated_public_repositories',automatic_discovery:false,realtime:false}};}};
}

/** Configured numeric GitHub ids are authoritative for administrator access.
 * Reconcile on every authenticated request so old cookies cannot retain a
 * removed administrator grant. Independently assigned editors remain editors. */
export function reconcileGithubRole(db, account, adminGithubIds) {
  if(!account?.github_id)return account;
  const role=adminGithubIds.has(String(account.github_id))?'admin':account.role==='editor'?'editor':'user';
  if(role===account.role)return account;
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role,account.id);
  return {...account,role};
}
