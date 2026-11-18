export function createClientPlugin(React, css, dictionaries) {
  const h = React.createElement;
  const { useEffect, useId, useRef, useState, useSyncExternalStore } = React;
  const PACKAGE = '@local/model-context-budget';
  const PANEL = `${PACKAGE}:page`;
  const SESSION = `${PACKAGE}:session`;
  const NS = `${PACKAGE}:ui`;
  const CHANNEL = '/api';
  const ENDPOINT = 'local-model-context-budget/budget';

  function Icon({ size = 20 }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
      h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('path', { d: 'M7 8h10M7 12h6M7 16h3M16 12v5m-2-2 2 2 2-2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }));
  }

  function PanelRoot({ renderSlot }) {
    return h(React.Fragment, null, h('style', null, css), renderSlot(SESSION, {}));
  }

  function Page({ sessionId, useProjection, t, call, back, drafts, generation }) {
    const selection = useProjection('modelSelection', value => value?.next ?? value?.lastUsed);
    const preset = useProjection('agentPreset');
    const generationId = useSyncExternalStore(
      listener => generation.subscribe(listener), () => generation.getSnapshot()?.id,
    );
    const [view, setView] = useState(null);
    const [modelId, setModelId] = useState(() => drafts.get(sessionId)?.modelId ?? '');
    const [text, setText] = useState(() => drafts.get(sessionId)?.text ?? '');
    const [preview, setPreview] = useState(null);
    const [ack, setAck] = useState(false);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [refreshKey, setRefreshKey] = useState(0);
    const operation = useRef(null);
    const inputRef = useRef(null);
    const feedbackRef = useRef(null);
    const previewRef = useRef(null);
    const inputId = useId();
    const selectId = useId();
    const helpId = useId();
    const request = async (payload, signal) => {
      const response = await call({ ...payload, sessionId }, signal);
      if (!response.ok) throw new Error(response.error.message);
      return response.value;
    };
    const show = value => Number.isSafeInteger(value) ? value.toLocaleString() : t('unknown');
    const remember = (nextId, nextText) => { if (sessionId) drafts.set(sessionId, { modelId: nextId, text: nextText }); };
    const resetPreview = () => { setPreview(null); setAck(false); setSuccess(''); };

    useEffect(() => {
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      setPreview(null); setAck(false); setError(''); setSuccess(''); setView(null);
      const saved = drafts.get(sessionId);
      setText(saved?.text ?? '');
      setModelId(saved?.modelId ?? '');
      if (!sessionId) { setBusy(''); return () => controller.abort(); }
      setBusy('read');
      request({ action: 'read' }, controller.signal).then(next => {
        if (controller.signal.aborted) return;
        setView(next);
        const target = next.models.some(model => model.id === saved?.modelId) ? saved.modelId : next.selected.model;
        setModelId(target);
      }).catch(failure => {
        if (!controller.signal.aborted) setError(failure.message);
      }).finally(() => { if (!controller.signal.aborted) setBusy(''); });
      return () => { controller.abort(); operation.current?.abort(); };
    }, [sessionId, selection?.provider, selection?.model, preset, generationId, refreshKey]);

    useEffect(() => {
      if (error || success) feedbackRef.current?.focus();
    }, [error, success]);
    useEffect(() => { if (preview) previewRef.current?.focus(); }, [preview]);

    async function runPreview(event) {
      event.preventDefault();
      setError(''); setSuccess(''); setAck(false); setPreview(null);
      const target = Number(text);
      if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(target)) { setError(t('invalidTarget')); return; }
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      setBusy('preview');
      try {
        const result = await request({ action: 'preview', modelId, target }, controller.signal);
        if (!controller.signal.aborted) { setPreview(result); setView(result.view); }
      } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
      finally { if (!controller.signal.aborted) setBusy(''); }
    }

    async function save() {
      if (!preview || !ack || busy) return;
      const controller = new AbortController();
      operation.current?.abort(); operation.current = controller;
      setBusy('save'); setError(''); setSuccess('');
      try {
        const result = await request({ action: 'save', token: preview.token }, controller.signal);
        if (controller.signal.aborted) return;
        setView(result.view); setPreview(null); setAck(false);
        setSuccess(`${t('saved')} ${result.modelId}: contextWindow = ${show(result.contextWindow)}`);
      } catch (failure) {
        if (!controller.signal.aborted) { setError(failure.message); setPreview(null); setAck(false); }
      } finally { if (!controller.signal.aborted) setBusy(''); }
    }

    const data = view?.sessionId === sessionId ? view : null;
    const model = data?.models.find(row => row.id === modelId);
    const policy = model?.policy;
    const meta = (label, value) => h('div', { key: label }, h('dt', null, label), h('dd', null, value));
    const button = (label, onClick, primary = false, disabled = false) => h('button', {
      type: 'button', className: `mb559-button${primary ? ' mb559-primary' : ''}`, onClick, disabled,
    }, label);
    const comparison = (label, window, budget) => h('section', null,
      h('h3', null, label), h('dl', null,
        meta(t('window'), show(window)),
        meta(t('threshold'), show(budget?.thresholdTokens)),
        meta(t('retain'), show(budget?.retainTokens))));

    return h('main', { className: 'mb559-page', 'aria-busy': Boolean(busy) },
      h('div', { className: 'mb559-body' },
        h('header', { className: 'mb559-head' },
          h('div', null, h('h1', null, t('title')), h('p', null, t('subtitle'))),
          h('div', { className: 'mb559-actions' },
            button(t('back'), back),
            button(t('refresh'), () => { resetPreview(); setRefreshKey(value => value + 1); }, false, !sessionId || Boolean(busy)))),
        !sessionId && h('p', { className: 'mb559-notice' }, t('noSession')),
        busy === 'read' && h('p', { role: 'status', className: 'mb559-note' }, t('loading')),
        error && !data && h('div', { role: 'alert', className: 'mb559-notice mb559-error' }, h('strong', null, `${t('failure')}：`), ' ', error),
        data && h(React.Fragment, null,
          h('section', { className: 'mb559-card' },
            h('dl', { className: 'mb559-meta' },
              meta(t('session'), data.sessionId),
              meta(t('provider'), `${data.providerName} · ${data.selected.provider}`),
              meta(t('preset'), data.presetId ?? t('unknown')),
              meta(t('selected'), data.selected.model)),
            h('p', { className: 'mb559-note' }, t('scope')),
            h('p', { className: 'mb559-notice' }, t('override')),
            data.policyError && h('p', { className: 'mb559-notice mb559-error' }, t('policyUnknown'), ' ', data.policyError)),
          h('section', { className: 'mb559-card' },
            h('h2', null, t('models')),
            h('p', { className: 'mb559-note' }, t('capabilityHelp')),
            h('div', { className: 'mb559-table-wrap', tabIndex: 0, 'aria-label': t('models') },
              h('table', { className: 'mb559-table' },
                h('thead', null, h('tr', null,
                  ...['model', 'window', 'capacity', 'output', 'threshold', 'retain'].map(key => h('th', { key, scope: 'col' }, t(key))))),
                h('tbody', null, ...data.models.map(row => h('tr', { key: row.id, 'data-target': row.id === modelId },
                  h('td', null, h('button', { type: 'button', className: 'mb559-model-choice', disabled: Boolean(busy),
                    'aria-label': `${t('selectModel')}: ${row.name} (${row.id})`, 'aria-pressed': row.id === modelId,
                    onClick: () => { setModelId(row.id); remember(row.id, text); resetPreview(); setError(''); },
                  }, row.name), h('span', { className: 'mb559-source mb559-mono' }, row.id)),
                  h('td', { className: 'mb559-mono' }, show(row.contextWindow),
                    h('span', { className: 'mb559-source' }, t('configuredWindow'), ': ', row.configuredContextWindow === null ? t('notSet') : show(row.configuredContextWindow))),
                  h('td', { className: 'mb559-mono' }, show(row.capacityMaxTokens), h('span', { className: 'mb559-source' }, t(row.capacitySource))),
                  h('td', { className: 'mb559-mono' }, show(row.defaultOutputTokens)),
                  h('td', { className: 'mb559-mono' }, show(row.budget?.thresholdTokens)),
                  h('td', { className: 'mb559-mono' }, show(row.budget?.retainTokens))))))),
            data.models.length === 0 && h('p', { className: 'mb559-note' }, t('empty'))),
          h('section', { className: 'mb559-card' },
            h('h2', null, t('editHeading')),
            h('div', { ref: feedbackRef, tabIndex: -1, className: 'mb559-feedback' },
              error && h('div', { role: 'alert', className: 'mb559-notice mb559-error' }, h('strong', null, `${t('failure')}：`), ' ', error),
              success && h('p', { role: 'status', className: 'mb559-notice' }, success)),
            h('form', { className: 'mb559-form', onSubmit: runPreview },
              h('div', { className: 'mb559-form-row' },
                h('label', { className: 'mb559-field', htmlFor: selectId }, t('selectModel'),
                  h('select', { id: selectId, value: modelId, disabled: Boolean(busy),
                    onChange: event => { setModelId(event.target.value); remember(event.target.value, text); resetPreview(); setError(''); },
                  }, ...data.models.map(row => h('option', { key: row.id, value: row.id }, row.id)))),
                h('label', { className: 'mb559-field', htmlFor: inputId }, t('target'),
                  h('input', { ref: inputRef, id: inputId, value: text, inputMode: 'numeric', autoComplete: 'off',
                    disabled: Boolean(busy), 'aria-describedby': helpId,
                    onChange: event => { setText(event.target.value); remember(modelId, event.target.value); resetPreview(); setError(''); },
                  }))),
              h('p', { id: helpId, className: 'mb559-note' }, t('targetHelp')),
              policy && h(React.Fragment, null,
                h('dl', { className: 'mb559-meta' },
                  meta(t('ratio'), String(policy.thresholdRatio)),
                  meta(t('headroom'), show(policy.headroomTokens)),
                  meta(t('retentionPolicy'), policy.retainTokens === undefined ? `retainRatio = ${policy.retainRatio}` : `retainTokens = ${show(policy.retainTokens)}`),
                  meta(t('policySource'), policy.exactOverride ? t('exactPolicy') : t('defaultPolicy'))),
                policy.auto === false && h('p', { className: 'mb559-notice' }, t('autoOff'))),
              model?.budgetError && h('p', { className: 'mb559-notice mb559-error' }, model.budgetError),
              model && !model.writable && h('p', { className: 'mb559-note' }, t('readOnly')),
              h('pre', { className: 'mb559-code mb559-mono' }, 'threshold = floor(min(r × W, W − O − B))\nW = ceil(max(T / r, T + O + B))'),
              h('div', { className: 'mb559-actions' }, h('button', {
                type: 'submit', className: 'mb559-button mb559-primary', disabled: Boolean(busy) || !model?.writable || !text,
              }, busy === 'preview' ? t('loading') : t('preview'))))),
          preview && h('section', { ref: previewRef, tabIndex: -1, className: 'mb559-card mb559-feedback', 'aria-label': t('previewHeading') },
            h('h2', null, t('previewHeading')),
            h('p', { className: 'mb559-note' }, `${preview.modelId} · ${t('target')}: ${show(preview.target)}`),
            h('div', { className: 'mb559-compare' },
              comparison(t('before'), preview.currentWindow, preview.before),
              comparison(t('after'), preview.after.contextWindow, preview.after)),
            h('p', { className: 'mb559-notice', role: 'status' }, t('verified')),
            preview.after.contextWindow > preview.currentWindow && h('p', { className: 'mb559-notice' }, t('capacityWarning')),
            h('p', { className: 'mb559-note' }, t('retentionImpact'), ': ', preview.before
              ? `${preview.after.retainTokens - preview.before.retainTokens >= 0 ? '+' : ''}${show(preview.after.retainTokens - preview.before.retainTokens)}`
              : t('unknown'), ' tokens. ', t('retentionHelp')),
            h('pre', { className: 'mb559-code mb559-mono' }, `${t('field')}: ${preview.settingsNs}\n${preview.writePath.join(' → ')} = ${preview.after.contextWindow}`),
            h('p', { className: 'mb559-note' }, t('unchangedOthers')),
            h('label', { className: 'mb559-confirm' }, h('input', { type: 'checkbox', checked: ack, disabled: Boolean(busy), onChange: event => setAck(event.target.checked) }), t('acknowledge')),
            h('div', { className: 'mb559-actions' },
              button(busy === 'save' ? t('saving') : t('save'), save, true, !ack || Boolean(busy)),
              button(t('cancel'), () => { setPreview(null); setAck(false); inputRef.current?.focus(); }, false, Boolean(busy)))))));
  }

  return {
    inject: ['slots', 'layout', 'locale', 'connection', 'uiSession'],
    apply(ctx) {
      const lifetime = new AbortController();
      const drafts = new Map();
      ctx.effect(() => ctx.locale.register(NS, dictionaries));
      const t = ctx.locale.bind(NS);
      const call = (payload, signal) => ctx.connection.rpc.call(CHANNEL, ENDPOINT, payload,
        signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal);
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL, children: {
          [SESSION]: { kind: 'single', scope: 'session-maybe' },
        } }, PanelRoot);
        yield ctx.slots.register({ name: SESSION, locale: NS, inject: () => ({
          call, back: () => ctx.layout.selectPanel(null), drafts, generation: ctx.connection.generation,
        }) }, Page);
      });
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL, order: 30, label: () => t('title'), locale: NS,
      }, Icon));
      ctx.effect(() => () => {
        lifetime.abort(); drafts.clear();
        if (ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL) ctx.layout.selectPanel(null);
      });
    },
  };
}
