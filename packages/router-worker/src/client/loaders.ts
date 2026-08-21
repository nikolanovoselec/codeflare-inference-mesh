/**
 * Wizard data loaders: zones, gateways, installers and the gateway payload.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_LOADERS = `\
  // --- wizard data loaders ----------------------------------------------------
  let accessIdents = { admin: [], user: [] };
  const isGroupIdent = (value) => value.indexOf('@') < 0;
  const looksLikeEmail = (value) => {
    const at = value.indexOf('@');
    if (at <= 0 || at !== value.lastIndexOf('@')) return false;
    const dot = value.indexOf('.', at + 1);
    return dot > at + 1 && dot < value.length - 1;
  };
  function renderIdentChips(kind) {
    const list = byId('wizard-' + kind + '-idents');
    if (!list) return;
    list.textContent = '';
    accessIdents[kind].forEach((ident) => {
      const item = document.createElement('li');
      item.className = 'email-chip';
      item.setAttribute('data-ident-chip', ident);
      item.setAttribute('data-ident-kind', kind);
      const text = document.createElement('span');
      text.textContent = ident + (isGroupIdent(ident) ? ' (group)' : '');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost';
      remove.textContent = 'Remove';
      remove.setAttribute('data-remove-ident', ident);
      remove.setAttribute('data-remove-kind', kind);
      item.append(text, remove);
      list.appendChild(item);
    });
  }
  async function loadZones() {
    const slot = byId('wizard-zone-slot');
    if (!slot) return;
    let zones = [];
    try {
      const body = await request('/admin/cloudflare/zones', { headers: headers(false) });
      zones = Array.isArray(body.zones) ? body.zones : [];
    } catch (error) { zones = []; }
    slot.textContent = '';
    const select = document.createElement('select');
    select.id = 'wizard-domain-zone';
    select.name = 'zoneId';
    select.setAttribute('data-zone-select', 'true');
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Auto-detect from hostname';
    select.appendChild(auto);
    zones.forEach((zone) => {
      const option = document.createElement('option');
      option.value = zone.id;
      option.setAttribute('data-zone-option', zone.id);
      option.textContent = zone.name;
      select.appendChild(option);
    });
    slot.appendChild(select);
  }
  function fillChoiceSelect(slotId, selectId, name, marker, values, selectedValue, createLabel) {
    const slot = byId(slotId);
    if (!slot) return;
    slot.textContent = '';
    const select = document.createElement('select');
    select.id = selectId;
    select.name = name;
    select.setAttribute(marker, 'true');
    values.forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.setAttribute('data-choice-option', value);
      if (value === selectedValue) option.selected = true;
      option.textContent = value;
      select.appendChild(option);
    });
    const createNew = document.createElement('option');
    createNew.value = '__new__';
    createNew.setAttribute('data-choice-option', '__new__');
    createNew.textContent = createLabel;
    if (selectedValue === '__new__') createNew.selected = true;
    select.appendChild(createNew);
    select.value = selectedValue;
    slot.appendChild(select);
  }
  const toggleNewField = (wrapId, show) => { const wrap = byId(wrapId); if (wrap) wrap.hidden = !show; };
  // The wizard and the Routing section share one gateway-discovery flow; the scope
  // selects which set of element ids to populate so the two never collide.
  function gatewayScopeIds(scope) {
    if (scope === 'routing') return { empty: 'rt-gateway-empty', selects: 'rt-gateway-selects', gwSlot: 'rt-gateway-slot', gwSelect: 'rt-gateway-select', gwNew: 'rt-gateway-new-wrap', providerName: 'rt-gateway-provider-name' };
    return { empty: 'wizard-gateway-empty', selects: 'wizard-gateway-selects', gwSlot: 'wiz-gateway-slot', gwSelect: 'wiz-gateway-select', gwNew: 'wiz-gateway-new-wrap', providerName: 'wiz-gateway-provider-name' };
  }
  function selectedGatewayValue(scope) {
    const select = byId(gatewayScopeIds(scope).gwSelect);
    return select && select.value ? select.value : '';
  }
  async function loadGatewayOptions(gatewayId, scope) {
    const ids = gatewayScopeIds(scope);
    const emptyPanel = byId(ids.empty);
    const selects = byId(ids.selects);
    if (!emptyPanel || !selects) return;
    const currentGateway = selectedGatewayValue(scope);
    const body = await request('/admin/cloudflare/gateway/options' + (gatewayId ? '?gateway=' + encodeURIComponent(gatewayId) : ''), { headers: headers(false) });
    const gateways = (body.gateways || []).map((gateway) => gateway.id);
    const defaults = body.defaults || {};
    emptyPanel.hidden = gateways.length > 0;
    selects.hidden = gateways.length === 0;
    if (!gateways.length) { if (scope === 'routing') refreshProvisionChip('').catch(() => undefined); return; }
    const wantedGateway = gatewayId || currentGateway || defaults.gatewayId;
    const gatewayValue = gateways.indexOf(wantedGateway) >= 0 ? wantedGateway : '__new__';
    fillChoiceSelect(ids.gwSlot, ids.gwSelect, 'gatewayId', 'data-gateway-select', gateways, gatewayValue, 'Create new gateway\u2026');
    toggleNewField(ids.gwNew, gatewayValue === '__new__');
    if (scope === 'routing') refreshProvisionChip(gatewayValue).catch(() => undefined);
  }
  // The Routing card reflects the *selected* gateway's live provisioning (mesh route +
  // canonical provider), verified server-side. Route status belongs in that card, not
  // as a dangling chip above the action button.
  async function refreshProvisionChip(gatewayId) {
    const card = byId('gateway-current');
    const target = gatewayId && gatewayId !== '__new__' ? gatewayId : '';
    if (!card) return;
    if (!target) {
      renderStateCard(card, { label: 'AI Gateway', value: '', placeholder: 'Not connected yet', state: 'empty' });
      return;
    }
    try {
      const status = await request('/admin/cloudflare/gateway/provision-status?gateway=' + encodeURIComponent(target), { headers: headers(false) });
      renderStateCard(card, {
        label: 'AI Gateway',
        value: target,
        placeholder: 'Not connected yet',
        sub: status.provisioned ? routeSubLabel(gatewayRouteNames({ routes: lastStatus && lastStatus.gateway && lastStatus.gateway.routes, routeName: status.routeName })) : 'route not provisioned',
        chip: status.provisioned ? 'connected' : 'needs provisioning',
        chipTone: status.provisioned ? 'ok' : 'warn',
        state: status.provisioned ? 'ok' : 'empty'
      });
    } catch (error) {
      renderStateCard(card, { label: 'AI Gateway', value: target, placeholder: 'Not connected yet', sub: 'route status unavailable', chip: 'check failed', chipTone: 'warn', state: 'empty' });
    }
  }
  // Read the chosen (or newly named) gateway and the provider name from a
  // discovery scope's ids. The account id, worker url, route, and public model
  // are resolved server-side from the runtime token and Worker env.
  const discoveryGatewayPayload = (ids) => {
    const gatewaySelect = byId(ids.gwSelect);
    const gatewayId = gatewaySelect && gatewaySelect.value && gatewaySelect.value !== '__new__' ? gatewaySelect.value : readInput(ids.gwNew.replace('-new-wrap', '-new'));
    const providerName = ids.providerName ? readInput(ids.providerName) : '';
    const raw = { gatewayId, providerName };
    return Object.fromEntries(Object.entries(raw).filter((pair) => pair[1]));
  };

`
