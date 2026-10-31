/**
 * Texts the plugin writes into a chat, in English and Brazilian Portuguese (`locale` setting).
 * They are written as the plugin, never as the assistant: on 2026-10-19 and 10-30 a model took
 * "I'll tell you when it is ready" for a job of its own and called a tool instead of answering.
 */

export const LOCALES = Object.freeze(['en', 'pt-BR']);

const min = m => `${Number.isInteger(m) ? m : Number(m.toFixed(2))} min`;

const en = {
  where: label => `at the top of this conversation, under "background job" (task "Starting ${label}")`,
  starting: (label, where) => `🔌 ${label} was off. The dsh-hf-spaces plugin is starting its Hugging Face Space (3 to 7 min); progress shows ${where}. When it is ready, this session resumes by itself.`,
  stillStarting: (label, secs, line) => `⏳ ${label} is still starting (${secs} s${line ? `: ${line}` : ''}). When it is ready, this session resumes by itself.`,
  ready: (label, secs, pending) => [
    `[Automatic notice from the dsh-hf-spaces plugin, not a user message: ${label} started in ${secs} s and is answering.`,
    'The "🔌" and "⏳" messages above were written by the plugin, not by you; the start task has ended and there is no job to follow.',
    pending
      ? `Answer now the user's message that was left without an answer:\n\n«${pending}»]`
      : 'Answer now the last user message written before these notices.]',
  ].join(' '),
  failed: (label, reason, paused) => `${label} could not be started: ${reason}.${paused === false ? ' WARNING: the pause was not confirmed and the GPU may still bill; pause the Space on Hugging Face.' : ''}`,
  noCredential: (label, name, what) => `${label} was not started: the credential ${name} is missing from the Harness vault (a Hugging Face token ${what}). Add it to the vault under that name, then send the message again.`,
  readAccess: 'that can read the Space',
  writeAccess: 'with write access to the Space',
  waking: (label, where) => `⏳ ${label} is starting on Hugging Face; progress shows ${where}. When it is ready, this session resumes by itself.`,
  unknownState: label => `The state of ${label} could not be read from Hugging Face, so it was not started. Check the Space on Hugging Face and send the message again.`,
  cooldown: label => `The last attempt to start ${label} failed a moment ago, so it is not started again by itself. Try again in a few minutes.`,
  manualOnly: (label, route) => `${label} is off and its automatic start is disabled (start.automatic: false). Start it with /space on ${route}, then send the message again.`,
  rules: (stop, sleepSeconds) => {
    const parts = [];
    if (stop.idleMinutes > 0) parts.push(`after ${min(stop.idleMinutes)} without use`);
    if (stop.sessionMinutes > 0) parts.push(`${min(stop.sessionMinutes)} after the start began (warning ${min(stop.warnMinutes)} before; /space +${stop.extendMinutes} adds ${min(stop.extendMinutes)})`);
    parts.push('with /space off');
    return `It stops ${parts.join(', or ')}. These rules apply only while the Harness is open; when it is closed, only the Space's own sleep time stops it${sleepSeconds ? ` (${min(sleepSeconds / 60)} without use)` : ''}.`;
  },
  usage: 'Use /space [status | on | off | +N] [route]. Nothing is sent to the model.',
  noSpaces: 'No Space is registered; the plugin log says why each configured Space was refused.',
  whichSpace: routes => `Several Spaces are configured; add the route: ${routes.join(', ')}.`,
  unknownRoute: (route, routes) => `No Space uses the route "${route}"; the routes are ${routes.join(', ')}.`,
  phase: { off: 'off', starting: 'starting', ready: 'serving', stopping: 'stopping', failed: 'failed', unknown: 'state unknown' },
  status: d => [
    `${d.label} (${d.route}): ${d.phase}${d.stage ? ` (${d.stage})` : ''}${d.hardware ? ` on ${d.hardware}` : ''}.`,
    d.on ? `On for ${d.on}, estimated cost ${d.cost}.` : '',
    d.stopsAt ? `Stops at ${d.stopsAt}${d.idle ? `, or earlier after ${d.idle} without use` : ''}.` : d.idle ? `Stops after ${d.idle} without use.` : '',
    d.warning ? `Time limit soon: /space +${d.extend} adds ${d.extend} min.` : '',
    d.reason ? `Last: ${d.reason}.` : '',
    d.refused ? `Note: ${d.refused}.` : '',
  ].filter(Boolean).join(' '),
  onStarting: (label, rate, where) => `Starting ${label}${rate ? ` (${rate}/h while it starts and runs)` : ''}; progress shows ${where}. Nothing was sent to the model.`,
  alreadyServing: label => `${label} is already serving.`,
  offDone: (label, cost) => `${label} paused; billing stopped.${cost ? ` Estimated cost of this start: ${cost}.` : ''}`,
  offFailed: (label, warning) => `${label}: ${warning}`,
  alreadyOff: label => `${label} was already off.`,
  extended: (label, minutes, at, idle) => `Time limit extended by ${minutes} min: ${label} stops at ${at}${idle ? `, or earlier after ${idle} without use` : ''}.`,
  noLimit: label => `This start of ${label} has no time limit; nothing to extend.`,
  notRunning: label => `${label} is not running from this Harness; nothing to extend.`,
  progressLabel: label => `Starting ${label}`,
  phases: { allocate: 'Waiting for a Hugging Face GPU', copy: 'Copying the model', load: 'Loading the model', warmup: 'Warming up' },
  progressLine: (phase, percent, left) => `${phase} · ${percent}% · about ${left} left`,
  refusedEfforts: levels => `the Space refused the effort levels ${levels}; remove them from "reasoning" in the configuration or the manifest`,
  readyDetail: (label, elapsed) => `${label} ready in ${elapsed}`,
  stoppedDetail: 'stopped from the task; the Space was paused',
  stopUnconfirmed: reason => `stopped from the task, but the pause was not confirmed (${reason}); the GPU may still bill. Pause the Space on Hugging Face`,
  replaced: 'the configuration changed; the start goes on',
  sessionClosed: 'session closed; the start goes on',
};

const ptBR = {
  where: label => `no topo desta conversa, em "background job" (tarefa "Ligando ${label}")`,
  starting: (label, where) => `🔌 ${label} estava desligado. O plugin dsh-hf-spaces está ligando o Space no Hugging Face (3 a 7 min); o andamento aparece ${where}. Quando ele estiver pronto, a sessão retoma sozinha.`,
  stillStarting: (label, secs, line) => `⏳ ${label} ainda está ligando (há ${secs} s${line ? `: ${line}` : ''}). Quando ele estiver pronto, a sessão retoma sozinha.`,
  ready: (label, secs, pending) => [
    `[Aviso automático do plugin dsh-hf-spaces, não é mensagem do usuário: ${label} ligou em ${secs} s e já responde.`,
    'As mensagens "🔌" e "⏳" acima foram escritas pelo plugin, não por você; a tarefa de partida já terminou e não há job nem nada para acompanhar.',
    pending
      ? `Responda agora à mensagem do usuário que ficou sem resposta:\n\n«${pending}»]`
      : 'Responda agora à última mensagem do usuário escrita antes desses avisos.]',
  ].join(' '),
  failed: (label, reason, paused) => `Não consegui ligar ${label}: ${reason}.${paused === false ? ' ATENÇÃO: a pausa não foi confirmada e a GPU pode continuar cobrando; pause o Space no Hugging Face.' : ''}`,
  noCredential: (label, name, what) => `${label} não foi ligado: falta a credencial ${name} no cofre do Harness (token do Hugging Face ${what}). Grave-a no cofre com esse nome e mande a mensagem de novo.`,
  readAccess: 'que leia o Space',
  writeAccess: 'com escrita no Space',
  waking: (label, where) => `⏳ ${label} está ligando no Hugging Face; o andamento aparece ${where}. Quando ele estiver pronto, a sessão retoma sozinha.`,
  unknownState: label => `Não consegui ler o estado de ${label} no Hugging Face, então ele não foi ligado. Confira o Space no Hugging Face e mande a mensagem de novo.`,
  cooldown: label => `A última tentativa de ligar ${label} falhou há pouco, então ele não é ligado de novo sozinho. Tente outra vez em alguns minutos.`,
  manualOnly: (label, route) => `${label} está desligado e a partida automática está desativada (start.automatic: false). Ligue com /space on ${route} e mande a mensagem de novo.`,
  rules: (stop, sleepSeconds) => {
    const parts = [];
    if (stop.idleMinutes > 0) parts.push(`após ${min(stop.idleMinutes)} sem uso`);
    if (stop.sessionMinutes > 0) parts.push(`${min(stop.sessionMinutes)} depois do início da partida (aviso ${min(stop.warnMinutes)} antes; /space +${stop.extendMinutes} soma ${min(stop.extendMinutes)})`);
    parts.push('com /space off');
    return `Ele desliga ${parts.join(', ou ')}. Essas regras só valem com o Harness aberto; fechado, só a pausa do próprio Space o desliga${sleepSeconds ? ` (${min(sleepSeconds / 60)} sem uso)` : ''}.`;
  },
  usage: 'Use /space [status | on | off | +N] [rota]. Nada é enviado ao modelo.',
  noSpaces: 'Nenhum Space está registrado; o log do plugin diz por que cada Space configurado foi recusado.',
  whichSpace: routes => `Há vários Spaces configurados; acrescente a rota: ${routes.join(', ')}.`,
  unknownRoute: (route, routes) => `Nenhum Space usa a rota "${route}"; as rotas são ${routes.join(', ')}.`,
  phase: { off: 'desligado', starting: 'ligando', ready: 'servindo', stopping: 'desligando', failed: 'falhou', unknown: 'estado desconhecido' },
  status: d => [
    `${d.label} (${d.route}): ${d.phase}${d.stage ? ` (${d.stage})` : ''}${d.hardware ? ` em ${d.hardware}` : ''}.`,
    d.on ? `Ligado há ${d.on}, custo estimado ${d.cost}.` : '',
    d.stopsAt ? `Desliga às ${d.stopsAt}${d.idle ? `, ou antes após ${d.idle} sem uso` : ''}.` : d.idle ? `Desliga após ${d.idle} sem uso.` : '',
    d.warning ? `Teto chegando: /space +${d.extend} soma ${d.extend} min.` : '',
    d.reason ? `Último: ${d.reason}.` : '',
    d.refused ? `Atenção: ${d.refused}.` : '',
  ].filter(Boolean).join(' '),
  onStarting: (label, rate, where) => `Ligando ${label}${rate ? ` (${rate}/h enquanto liga e roda)` : ''}; o andamento aparece ${where}. Nada foi enviado ao modelo.`,
  alreadyServing: label => `${label} já está servindo.`,
  offDone: (label, cost) => `${label} pausado; parou de cobrar.${cost ? ` Custo estimado desta partida: ${cost}.` : ''}`,
  offFailed: (label, warning) => `${label}: ${warning}`,
  alreadyOff: label => `${label} já estava desligado.`,
  extended: (label, minutes, at, idle) => `Teto estendido em ${minutes} min: ${label} desliga às ${at}${idle ? `, ou antes após ${idle} sem uso` : ''}.`,
  noLimit: label => `Esta partida de ${label} não tem teto; nada a estender.`,
  notRunning: label => `${label} não está ligado por este Harness; nada a estender.`,
  progressLabel: label => `Ligando ${label}`,
  phases: { allocate: 'Aguardando a GPU do Hugging Face', copy: 'Copiando o modelo', load: 'Carregando o modelo', warmup: 'Aquecendo' },
  progressLine: (phase, percent, left) => `${phase} · ${percent}% · faltam ~${left}`,
  refusedEfforts: levels => `o Space recusou os níveis de esforço ${levels}; tire-os de "reasoning" na configuração ou no manifesto`,
  readyDetail: (label, elapsed) => `${label} pronto em ${elapsed}`,
  stoppedDetail: 'parado pela tarefa; o Space foi pausado',
  stopUnconfirmed: reason => `parado pela tarefa, mas a pausa não foi confirmada (${reason}); a GPU pode continuar cobrando. Pause o Space no Hugging Face`,
  replaced: 'a configuração mudou; a partida continua',
  sessionClosed: 'sessão encerrada; a partida continua',
};

/** The text set for a locale; English when the locale is unknown. */
export const textsFor = locale => (locale === 'pt-BR' ? ptBR : en);
