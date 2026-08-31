/* ============================================================
   BRAIN ROT — COMBAT SYSTEM (ES Module)
   Online 1v1 (PeerJS) + offline self-multiplying horde.
   Requires: three importmap, PeerJS global, #dmg-layer element.
   Game must provide (constructor arg):
   scene, camera, state, player, worldHalf, getTerrainHeight,
   collideBody(pos,r,h), raySolid(o,d,maxD)->Vec3|null,
   spatial, burst, hitmark, scorePop, addShake, banner,
   damageFeedback, setPhase, getLocalState, deploy, dmgLayer,
   sfx:{shotAt,hitFlesh,headshot,hurt,respawn,win,lose,beep,heartbeat}
============================================================ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const SOLDIER_URL = 'https://threejs.org/examples/models/gltf/Soldier.glb';
const KILLS_TO_WIN = 5;
const ROOM_PREFIX = 'brainrot-room-';
const PRES_PREFIX = 'brainrot-pres-';
const LS_NAME = 'brainrot-name';
const LS_RECENT = 'brainrot-recent';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function lerpAngle(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
}
export const HIT_SPHERES = [
    { x: 0, y: 2.02, z: 0, r: 0.15, zone: 'head' },
    { x: 0, y: 1.78, z: 0, r: 0.30, zone: 'torso' },
    { x: 0, y: 1.45, z: 0, r: 0.28, zone: 'torso' },
    { x: 0, y: 1.15, z: 0, r: 0.26, zone: 'torso' },
    { x: 0, y: 1.02, z: 0, r: 0.25, zone: 'torso' },
    { x: -0.36, y: 1.38, z: 0, r: 0.12, zone: 'legs' },
    { x: 0.36, y: 1.38, z: 0, r: 0.12, zone: 'legs' },
    { x: -0.13, y: 0.50, z: 0, r: 0.22, zone: 'legs' },
    { x: 0.13, y: 0.50, z: 0, r: 0.22, zone: 'legs' }
];
export const ZONE_DMG = { head: 85, torso: 34, legs: 26 };

const _ta = new THREE.Vector3(), _tb = new THREE.Vector3();

export class CombatSystem {
    constructor(game) {
        this.g = game;
        this.mode = null;                // 'offline' | 'online'
        this.phase = 'lobby';
        this.enemies = [];
        this.remote = null;
        this.tracers = [];
        this.dmgPool = []; this.dmgActive = [];
        this.assetsReady = false; this.template = null; this.clips = {};
        this.offlineKills = 0;
        // network
        this.peer = null; this.conn = null; this.connOpen = false; this.isHost = false;
        this.roomCode = ''; this.myKills = 0; this.foeKills = 0;
        this.myRematch = false; this.theirRematch = false; this.opponentLeft = false;
        this.peerLoaded = false; this.iLoadedSent = false;
        this.countT = 0; this.lastCount = 99; this.netAcc = 0; this.respawnT = 0;
        try { this.myName = (localStorage.getItem(LS_NAME) || '').trim().toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 10) || 'PLAYER'; } catch (e) { this.myName = 'PLAYER'; }
        this.foeName = 'FOE';
        // presence / invites
        this.presencePeer = null; this.presenceReady = false; this.probeResolve = null; this.refreshing = false;
        this.inviteActive = false; this.inviteConn = null; this.inviteTimer = null; this.inviteTargetId = null;
        this.pendingInvite = null; this.pendingInviteCode = null; this.pendingInviteTimer = null;
        this.presTimer = 0;
        this.tracerGeo = new THREE.BoxGeometry(0.045, 0.045, 0.65);
        this.tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, toneMapped: false });
        this.remoteFlash = new THREE.PointLight(0xffaa44, 0, 8, 2);
        this.remoteGlow = new THREE.Mesh(new THREE.OctahedronGeometry(0.1), new THREE.MeshBasicMaterial({ color: 0xffc46b, toneMapped: false }));
        this.remoteGlow.visible = false;
        game.scene.add(this.remoteFlash);
        game.scene.add(this.remoteGlow);
        this.loadAssets();
        this.bindUI();
        window.addEventListener('beforeunload', () => { this.destroyNet(); this.stopPresence(); });
    }

    /* ---------- ASSETS ---------- */
    loadAssets() {
        new GLTFLoader().load(SOLDIER_URL, (gltf) => {
            this.template = gltf.scene;
            this.template.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
            const find = n => THREE.AnimationClip.findByName(gltf.animations, n);
            this.clips = {
                idle: find('Idle') || gltf.animations[0],
                walk: find('Walk'),
                run: find('Run')
            };
            this.assetsReady = true;
            this.announceLoaded();
        }, undefined, () => { this.assetsReady = true; this.announceLoaded(); }); // fallback bodies
    }
    makeRifle() {
        const metal = new THREE.MeshStandardMaterial({ color: 0x23262b, metalness: 0.75, roughness: 0.35 });
        const dark = new THREE.MeshStandardMaterial({ color: 0x14161a, metalness: 0.4, roughness: 0.6 });
        const g = new THREE.Group();
        const p = (w, h, d, x, y, z, m) => {
            const mm = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m || metal);
            mm.position.set(x, y, z);
            mm.castShadow = true;
            g.add(mm);
        };
        p(0.07, 0.09, 0.5, 0, 0, 0);
        p(0.055, 0.055, 0.3, 0, 0.01, -0.35, dark);
        p(0.05, 0.12, 0.19, 0, -0.02, 0.3, dark);
        p(0.045, 0.11, 0.07, 0, -0.1, 0.12, dark);
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.3, 8), metal);
        b.rotation.x = Math.PI / 2;
        b.position.set(0, 0.02, -0.5);
        g.add(b);
        const mz = new THREE.Object3D();
        mz.position.set(0, 0.02, -0.66);
        g.add(mz);
        g.userData.muzzle = mz;
        return g;
    }
    makeFallback() {
        const g = new THREE.Group();
        const skin = new THREE.MeshStandardMaterial({ color: 0x8a7a5e, flatShading: true });
        const cloth = new THREE.MeshStandardMaterial({ color: 0x3a4a3a, flatShading: true });
        const box = (w, h, d, x, y, z, m) => { const mm = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); mm.position.set(x, y, z); mm.castShadow = true; g.add(mm); };
        box(0.5, 0.75, 0.3, 0, 1.05, 0, cloth);
        box(0.34, 0.36, 0.36, 0, 1.62, 0, skin);
        box(0.14, 0.62, 0.14, -0.34, 1.1, 0, cloth);
        box(0.14, 0.62, 0.14, 0.34, 1.1, 0, cloth);
        box(0.18, 0.72, 0.2, -0.14, 0.36, 0, cloth);
        box(0.18, 0.72, 0.2, 0.14, 0.36, 0, cloth);
        return g;
    }
    makeSoldier() {
        let model, mixer = null, actions = null, head = null, muzzle = null;
        if (this.template) {
            model = SkeletonUtils.clone(this.template);
            model.scale.setScalar(1.22);
            model.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
            mixer = new THREE.AnimationMixer(model);
            actions = {
                idle: mixer.clipAction(this.clips.idle),
                walk: this.clips.walk ? mixer.clipAction(this.clips.walk) : null,
                run: this.clips.run ? mixer.clipAction(this.clips.run) : null
            };
            actions.walk = actions.walk || actions.idle;
            actions.run = actions.run || actions.walk;
            actions.idle.play();
            const self = this;
            model.traverse(c => {
                if (!c.isBone) return;
                if (/Head$/i.test(c.name)) head = c;
                else if (/RightHand$/i.test(c.name)) {
                    const rifle = self.makeRifle();
                    rifle.position.set(0.02, 0.11, 0.03);
                    rifle.rotation.set(Math.PI / 2, 0, 0);
                    c.add(rifle);
                    muzzle = rifle.userData.muzzle;
                }
            });
        } else {
            model = this.makeFallback();
        }
        const wrap = new THREE.Group();
        wrap.add(model);
        return {
            g: wrap, model, mixer, actions, head, muzzle,
            pos: new THREE.Vector3(), state: 'idle', hp: 100,
            dead: false, fallT: 0, sinkT: 0, punch: 0,
            wanderTarget: null, idleT: 1 + Math.random() * 3,
            strafeDir: Math.random() < 0.5 ? 1 : -1, strafeT: 0,
            evadeT: 0, shootT: 1.5 + Math.random() * 2.5,
            headT: Math.random() * 10, animT: Math.random() * 10,
            lx: 0, lz: 0, stuckT: 0,
            // remote-only
            targetPos: null, targetYaw: 0, yaw: 0, pitch: 0, anim: 'idle', gunKick: 0
        };
    }
    setAnim(e, s) {
        if (!e.actions || e.state === s) return;
        const from = e.actions[e.state], to = e.actions[s];
        e.state = s;
        if (to && to !== from) { to.reset().fadeIn(0.25).play(); if (from && from !== to) from.fadeOut(0.25); }
    }

    /* ---------- UI ---------- */
    bindUI() {
        const el = id => document.getElementById(id);
        this.dom = {
            lobby: el('lobby'), menu: el('lobby-menu'), wait: el('lobby-wait'),
            nameInput: el('name-input'), codeInput: el('code-input'),
            roomCode: el('room-code'), netStatus: el('net-status'),
            recentList: el('recent-list'), inviteStatus: el('invite-status'),
            countNum: el('count-num'), deathOverlay: el('death-overlay'),
            over: el('over'), overTitle: el('over-title'), overSub: el('over-sub'),
            rematchStatus: el('rematch-status'), dc: el('dc'),
            inviteModal: el('invite-modal'), inviteFrom: el('invite-from')
        };
        if (this.dom.nameInput) {
            this.dom.nameInput.value = this.myName === 'PLAYER' ? '' : this.myName;
            el('btn-setname').addEventListener('click', () => this.saveName());
            this.dom.nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.saveName(); this.dom.nameInput.blur(); } });
        }
        el('btn-solo').addEventListener('click', () => { this.saveName(); this.startOffline(); });
        el('btn-create').addEventListener('click', () => { this.cancelPendingInvite(); this.saveName(); this.createRoom(this.makeCode()); });
        el('btn-join').addEventListener('click', () => {
            this.cancelPendingInvite(); this.saveName();
            const code = this.dom.codeInput.value.trim().toLowerCase();
            if (code.length < 4) { this.showLobbyWait('----'); this.netStatus('ENTER THE 4-CHARACTER CODE'); return; }
            this.joinRoom(code);
        });
        el('btn-lobby-back').addEventListener('click', () => { this.destroyNet(); this.showLobbyMenu(); });
        el('btn-invite-accept').addEventListener('click', () => this.respondInvite(true));
        el('btn-invite-decline').addEventListener('click', () => this.respondInvite(false));
        el('btn-respawn').addEventListener('click', () => { if (this.mode === 'offline' && this.g.state.dead) this.respawnLocal(); });
        el('btn-rematch').addEventListener('click', () => {
            if (this.opponentLeft) { this.dom.rematchStatus.textContent = 'OPPONENT LEFT — RETURN TO LOBBY'; return; }
            this.myRematch = true;
            this.dom.rematchStatus.textContent = 'WAITING FOR OPPONENT…';
            this.sendMsg({ t: 'rematch' });
            this.checkRematch();
        });
        el('btn-lobby-exit').addEventListener('click', () => { this.sendMsg({ t: 'leave' }); setTimeout(() => this.exitToLobby(), 150); });
        el('btn-dc-reload').addEventListener('click', () => this.exitToLobby());
    }
    netStatus(t) { if (this.dom.netStatus) this.dom.netStatus.textContent = t; }
    setInviteStatus(t) { if (this.dom.inviteStatus) this.dom.inviteStatus.textContent = t; }
    showLobbyMenu() {
        this.cancelPendingInvite();
        if (this.pendingInvite) this.respondInvite(false);
        if (this.dom.inviteModal) this.dom.inviteModal.style.display = 'none';
        this.dom.lobby.classList.remove('hide');
        this.dom.menu.style.display = 'block';
        this.dom.wait.style.display = 'none';
        this.dom.over.style.display = 'none';
        this.dom.dc.style.display = 'none';
        this.dom.deathOverlay.style.display = 'none';
        this.phase = 'lobby';
        this.g.setPhase('lobby');
        this.peerLoaded = false;
        this.iLoadedSent = false;
        this.opponentLeft = false;
        this.refreshRecent();
    }
    showLobbyWait(code) {
        this.dom.menu.style.display = 'none';
        this.dom.wait.style.display = 'block';
        this.dom.roomCode.textContent = code.toUpperCase();
    }
    saveName() {
        if (!this.dom.nameInput) return;
        let v = this.dom.nameInput.value.trim().toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 10);
        if (!v) v = 'PLAYER';
        if (v !== this.myName) {
            this.myName = v;
            try { localStorage.setItem(LS_NAME, v); } catch (e) {}
            this.startPresence();
        }
    }

    /* ---------- MATCH FLOW ---------- */
    makeCode() {
        const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
        let s = '';
        for (let i = 0; i < 4; i++) s += chars[(Math.random() * chars.length) | 0];
        return s;
    }
    mySpawn() { return this.isHost ? { x: -52, z: -52, yaw: -2.356 } : { x: 52, z: 52, yaw: 0.785 }; }
    foeSpawn() { return this.isHost ? { x: 52, z: 52, yaw: 0.785 } : { x: -52, z: -52, yaw: -2.356 }; }
    startOffline() {
        this.mode = 'offline';
        this.beginCountdown();
    }
    beginCountdown() {
        const g = this.g;
        this.phase = 'countdown';
        g.setPhase('countdown');
        g.deploy();
        this.countT = 3.2;
        this.lastCount = 99;
        this.myKills = 0; this.foeKills = 0;
        g.state.health = 100;
        g.state.dead = false;
        g.player.deathT = 0;
        this.myRematch = false; this.theirRematch = false;
        // clear offline horde
        for (const e of this.enemies) g.scene.remove(e.g);
        this.enemies.length = 0;
        this.offlineKills = 0;
        if (this.mode === 'online') {
            const s = this.mySpawn();
            g.camera.position.set(s.x, g.player.height, s.z);
            g.player.yaw = s.yaw; g.player.pitch = 0;
            const f = this.foeSpawn();
            if (!this.remote) { this.remote = this.makeSoldier(); this.remote.targetPos = new THREE.Vector3(); g.scene.add(this.remote.g); }
            this.remote.pos.set(f.x, 0, f.z);
            this.remote.targetPos.set(f.x, 0, f.z);
            this.remote.yaw = this.remote.targetYaw = f.yaw;
            this.remote.dead = false;
            this.remote.fallT = 0;
            this.remote.g.rotation.x = 0;
        }
        this.dom.countNum.style.display = 'block';
        this.dom.over.style.display = 'none';
    }
    startFight() {
        const g = this.g;
        this.phase = 'fight';
        g.setPhase('fight');
        this.dom.countNum.style.display = 'none';
        g.banner('FIGHT', this.mode === 'offline' ? 'KILL ONE — TWO MORE RISE' : 'FIRST TO ' + KILLS_TO_WIN + ' KILLS');
        g.sfx.beep(true);
        if (this.mode === 'offline') this.spawnEnemy();
    }

    /* ---------- OFFLINE HORDE ---------- */
    spawnEnemy() {
        const g = this.g;
        const e = this.makeSoldier();
        for (let t = 0; t < 8; t++) {
            const a = Math.random() * Math.PI * 2;
            const d = 22 + Math.random() * 10;
            const x = clamp(g.camera.position.x + Math.cos(a) * d, -g.worldHalf + 3, g.worldHalf - 3);
            const z = clamp(g.camera.position.z + Math.sin(a) * d, -g.worldHalf + 3, g.worldHalf - 3);
            const y = g.getTerrainHeight(x, z);
            e.pos.set(x, y, z);
            if (!g.raySolid(_ta.set(x, y + 1, z), _tb.set(0, -1, 0), 1.5)) break;
        }
        e.lx = e.pos.x; e.lz = e.pos.z;
        g.scene.add(e.g);
        this.enemies.push(e);
    }
    enemyKilled(e) {
        const g = this.g;
        e.dead = true;
        e.fallT = 0;
        e.sinkT = 0;
        this.offlineKills++;
        g.hitmark(true);
        const c = e.pos.clone();
        c.y += 1.2;
        g.burst(c, 0x7a2a2a, 14, 7, 0.14, true);
        g.banner('ELIMINATED — ' + this.offlineKills, 'TWO MORE RISE');
        const cap = clamp(2 + this.offlineKills, 3, 8);
        for (let i = 0; i < 2 && this.enemies.filter(x => !x.dead).length < cap; i++) this.spawnEnemy();
    }
    updateEnemy(e, dt) {
        const g = this.g;
        if (e.dead) {
            if (e.mixer) e.mixer.update(dt);
            if (e.fallT < 0.5) {
                e.fallT += dt;
                const p = Math.min(1, e.fallT / 0.5);
                e.g.rotation.x = -(p * p) * Math.PI / 2 * 0.96;
            } else {
                e.sinkT += dt;
                if (e.sinkT > 2.2) {
                    e.g.position.y -= dt * 0.7;
                    if (e.g.position.y < e.pos.y - 3) {
                        g.scene.remove(e.g);
                        const i = this.enemies.indexOf(e);
                        if (i >= 0) this.enemies.splice(i, 1);
                    }
                }
            }
            return;
        }
        if (e.mixer) e.mixer.update(dt);
        if (e.punch > 0) { e.punch -= dt; e.g.scale.setScalar(1 + Math.max(0, e.punch / 0.15) * 0.14); } else if (e.g.scale.x !== 1) e.g.scale.setScalar(1);
        const cam = g.camera.position;
        const dx = cam.x - e.pos.x, dz = cam.z - e.pos.z;
        const dist = Math.hypot(dx, dz) || 0.001;
        if (e.evadeT > 0) e.evadeT -= dt;
        let mvx = 0, mvz = 0, speed = 0, targetYaw = null;
        if (dist < 16 || e.evadeT > 0) {
            this.setAnim(e, 'run');
            e.strafeT -= dt;
            if (e.strafeT <= 0) { e.strafeT = 1.2 + Math.random() * 1.8; e.strafeDir = Math.random() < 0.5 ? 1 : -1; }
            const nx = dx / dist, nz = dz / dist;
            const ring = clamp((12 - dist) * 0.15, -1, 1);
            mvx = -nz * e.strafeDir - nx * ring;
            mvz = nx * e.strafeDir - nz * ring;
            speed = 5.2;
        } else if (e.wanderTarget) {
            const wx = e.wanderTarget.x - e.pos.x, wz = e.wanderTarget.z - e.pos.z;
            const wd = Math.hypot(wx, wz);
            if (wd < 1.2) { e.wanderTarget = null; e.idleT = 2 + Math.random() * 4; }
            else { this.setAnim(e, 'walk'); mvx = wx / wd; mvz = wz / wd; speed = 1.6; }
        } else {
            this.setAnim(e, 'idle');
            e.idleT -= dt;
            if (e.idleT <= 0) e.wanderTarget = { x: (Math.random() - 0.5) * 2 * (g.worldHalf - 6), z: (Math.random() - 0.5) * 2 * (g.worldHalf - 6) };
            targetYaw = Math.atan2(dx, dz) + Math.PI;
        }
        if (speed > 0) {
            const ml = Math.hypot(mvx, mvz) || 1;
            mvx /= ml; mvz /= ml;
            e.pos.x += mvx * speed * dt;
            e.pos.z += mvz * speed * dt;
            const B = g.worldHalf - 1.2;
            e.pos.x = clamp(e.pos.x, -B, B);
            e.pos.z = clamp(e.pos.z, -B, B);
            g.collideBody(e.pos, 0.5, 1.9);
            const step = speed * dt;
            const movedSq = (e.pos.x - e.lx) * (e.pos.x - e.lx) + (e.pos.z - e.lz) * (e.pos.z - e.lz);
            if (movedSq < step * step * 0.1) e.stuckT += dt; else e.stuckT = 0;
            if (e.stuckT > 0.5) { e.stuckT = 0; e.wanderTarget = null; e.strafeT = 0; }
            targetYaw = Math.atan2(mvx, mvz) + Math.PI;
        }
        if (e.head) {
            if (e.state === 'idle') {
                e.headT += dt;
                e.head.rotation.y = Math.sin(e.headT * 0.7) * 0.6 + Math.sin(e.headT * 1.9) * 0.25;
            } else e.head.rotation.y *= Math.max(0, 1 - dt * 6);
        }
        if (targetYaw !== null) e.g.rotation.y = lerpAngle(e.g.rotation.y, targetYaw, Math.min(1, dt * 8));
        e.lx = e.pos.x; e.lz = e.pos.z;
        e.pos.y = g.getTerrainHeight(e.pos.x, e.pos.z);
        e.g.position.copy(e.pos);
        e.shootT -= dt;
        if (e.shootT <= 0 && dist > 5 && dist < 30 && !g.state.dead) {
            e.shootT = 1.3 + Math.random() * 1.7;
            _ta.set(e.pos.x, e.pos.y + 1.7, e.pos.z);
            _tb.copy(g.camera.position).sub(_ta);
            const d = _tb.length();
            _tb.normalize();
            if (!g.raySolid(_ta, _tb, d - 0.6)) this.enemyFire(e);
        }
    }
    enemyFire(e) {
        const g = this.g;
        const origin = new THREE.Vector3();
        if (e.muzzle) { e.g.updateMatrixWorld(true); e.muzzle.getWorldPosition(origin); }
        else origin.set(e.pos.x, e.pos.y + 1.6, e.pos.z);
        const target = g.camera.position.clone();
        target.x += (Math.random() - 0.5) * 1.7;
        target.y += (Math.random() - 0.5) * 1.2;
        target.z += (Math.random() - 0.5) * 1.7;
        const dir = target.sub(origin).normalize();
        const solid = g.raySolid(origin, dir, 70);
        const range = solid ? origin.distanceTo(solid) : 70;
        // closest approach to the player
        const toCam = g.camera.position.clone().sub(origin);
        const t = clamp(toCam.dot(dir), 0, range);
        const closest = origin.clone().addScaledVector(dir, t);
        if (closest.distanceTo(g.camera.position) < 0.5) this.damageLocal(10 + (Math.random() * 6 | 0));
        else if (solid) g.burst(solid, 0xb0a898, 3, 2.5, 0.07, true);
        this.spawnTracer(origin, dir, range / 95);
        const sp = g.spatial(e.pos);
        g.sfx.shotAt(sp.vol, sp.pan);
    }

    /* ---------- COMBAT ---------- */
    fireLocalShot(origin, dir) {
        const g = this.g;
        const solid = g.raySolid(origin, dir, 110);
        const maxD = solid ? origin.distanceTo(solid) : 110;
        const pt = new THREE.Vector3();
        let hit = null, zone = 'torso', target = null;
        outer:
        for (let d = 0.5; d <= maxD; d += 0.5) {
            pt.copy(origin).addScaledVector(dir, d);
            const list = this.mode === 'online'
                ? (this.remote && !this.remote.dead ? [this.remote] : [])
                : this.enemies;
            for (const tg of list) {
                if (tg.dead) continue;
                for (const hz of HIT_SPHERES) {
                    const cx = tg.pos.x + hz.x, cy = tg.pos.y + hz.y, cz = tg.pos.z + hz.z;
                    const ddx = pt.x - cx, ddy = pt.y - cy, ddz = pt.z - cz;
                    if (ddx * ddx + ddy * ddy + ddz * ddz < hz.r * hz.r) {
                        hit = pt.clone();
                        zone = hz.zone;
                        target = tg;
                        break outer;
                    }
                }
            }
        }
        if (hit && target) {
            const dmg = ZONE_DMG[zone];
            g.state.totalDmg += dmg;
            g.scorePop();
            g.burst(hit, 0x8a0f0f, zone === 'head' ? 10 : 7, 4.5, 0.11, true);
            const sp = g.spatial(target.pos);
            if (zone === 'head') g.sfx.headshot(sp.vol, sp.pan); else g.sfx.hitFlesh(sp.vol, sp.pan);
            this.spawnDmgNum(hit, dmg, zone === 'head' ? 'head' : zone === 'legs' ? 'limb' : '');
            if (this.mode === 'online') {
                this.sendMsg({ t: 'hit', part: zone, dmg: dmg });
                g.hitmark(false);
            } else {
                target.hp -= dmg;
                target.punch = 0.15;
                target.evadeT = 2.2;
                if (target.hp <= 0) this.enemyKilled(target); else g.hitmark(false);
            }
        } else if (solid) {
            g.burst(solid, 0xb0a898, 4, 2.5, 0.07, true);
        }
        this.spawnTracer(origin, dir, maxD / 95);
        if (this.mode === 'online') this.sendMsg({ t: 'shot', ox: origin.x, oy: origin.y, oz: origin.z, dx: dir.x, dy: dir.y, dz: dir.z });
    }
    spawnTracer(origin, dir, life) {
        const t = new THREE.Mesh(this.tracerGeo, this.tracerMat);
        t.position.copy(origin);
        t.quaternion.setFromUnitVectors(_ta.set(0, 0, -1), dir);
        this.g.scene.add(t);
        this.tracers.push({ mesh: t, dir: dir.clone(), life: Math.min(life, 1.2) });
    }
    damageLocal(dmg) {
        const g = this.g;
        if (this.phase !== 'fight' || g.state.dead) return;
        g.state.health -= dmg;
        g.damageFeedback();
        if (g.state.health <= 0) this.localDeath();
    }
    takeHit(part, dmg) { this.damageLocal(dmg); }
    localDeath() {
        const g = this.g;
        g.state.health = 0;
        g.state.dead = true;
        g.player.deathT = 0;
        if (this.mode === 'online') {
            this.sendMsg({ t: 'die' });
            this.respawnT = 3;
            g.banner('ELIMINATED', 'RESPAWNING…');
            this.foeKills++;
            if (this.foeKills >= KILLS_TO_WIN) this.showOver(false);
        } else {
            this.dom.deathOverlay.style.display = 'flex';
            g.banner('YOU DIED', 'TAP TO RESPAWN');
        }
    }
    respawnLocal() {
        const g = this.g;
        g.state.health = 100;
        g.state.dead = false;
        g.player.deathT = 0;
        if (this.mode === 'online') {
            const s = this.mySpawn();
            g.camera.position.set(s.x, g.player.height, s.z);
            g.player.yaw = s.yaw;
            this.sendMsg({ t: 'respawn' });
            g.banner('RESPAWNED', 'GET BACK IN THERE');
        } else {
            for (const e of this.enemies) g.scene.remove(e.g);
            this.enemies.length = 0;
            this.offlineKills = 0;
            this.spawnEnemy();
            this.dom.deathOverlay.style.display = 'none';
            g.banner('RESPAWNED', 'THE HORDE RESETS');
        }
    }
    showOver(win) {
        const g = this.g;
        this.phase = 'over';
        g.setPhase('over');
        this.dom.overTitle.textContent = win ? 'VICTORY' : 'DEFEAT';
        this.dom.overTitle.className = 'over-title ' + (win ? 'win' : 'lose');
        this.dom.overSub.textContent = 'YOU ' + this.myKills + ' : ' + this.foeKills + ' ' + this.foeName;
        this.dom.rematchStatus.textContent = '';
        this.dom.over.style.display = 'flex';
        if (win) g.sfx.win(); else g.sfx.lose();
    }
    checkRematch() {
        if (this.phase !== 'over') return;
        if (this.myRematch && this.theirRematch) {
            if (this.isHost) { this.sendMsg({ t: 'start' }); this.beginCountdown(); }
        } else if (this.theirRematch) {
            this.dom.rematchStatus.textContent = 'OPPONENT WANTS A REMATCH';
        }
    }

    /* ---------- DAMAGE NUMBERS ---------- */
    spawnDmgNum(worldPos, text, cls) {
        let d = this.dmgPool.pop();
        if (!d) { d = { el: document.createElement('div'), pos: new THREE.Vector3() }; this.g.dmgLayer.appendChild(d.el); }
        d.el.className = 'dmg-num' + (cls ? ' ' + cls : '');
        d.el.textContent = text;
        d.el.style.display = 'block';
        d.pos.copy(worldPos);
        d.pos.x += (Math.random() - 0.5) * 0.3;
        d.t = 0;
        d.life = 1.15;
        this.dmgActive.push(d);
    }
    updateDmgNums(dt) {
        const cam = this.g.camera;
        for (let i = this.dmgActive.length - 1; i >= 0; i--) {
            const d = this.dmgActive[i];
            d.t += dt;
            d.pos.y += dt * 1.3;
            _ta.copy(d.pos).project(cam);
            if (_ta.z > 1 || d.t > d.life) { d.el.style.display = 'none'; this.dmgActive.splice(i, 1); this.dmgPool.push(d); continue; }
            d.el.style.left = ((_ta.x * 0.5 + 0.5) * window.innerWidth) + 'px';
            d.el.style.top = ((-_ta.y * 0.5 + 0.5) * window.innerHeight) + 'px';
            const k = d.t / d.life;
            d.el.style.opacity = k < 0.6 ? 1 : (1 - (k - 0.6) / 0.4);
        }
    }

    /* ---------- NETWORKING ---------- */
    sendMsg(o) { if (this.connOpen) { try { this.conn.send(o); } catch (e) {} } }
    destroyNet() {
        try { if (this.conn) this.conn.close(); } catch (e) {}
        try { if (this.peer) this.peer.destroy(); } catch (e) {}
        this.conn = null; this.peer = null; this.connOpen = false;
    }
    announceLoaded() {
        if (this.connOpen && this.assetsReady && !this.iLoadedSent) { this.iLoadedSent = true; this.sendMsg({ t: 'loaded' }); }
        if (this.isHost) this.tryHostStart();
    }
    tryHostStart() {
        if (this.isHost && this.connOpen && this.peerLoaded && this.assetsReady && this.phase === 'lobby') {
            this.mode = 'online';
            this.sendMsg({ t: 'start' });
            this.beginCountdown();
        }
    }
    createRoom(code) {
        const g = this.g;
        g.prepareSession();
        this.mode = 'online';
        this.isHost = true;
        this.roomCode = code;
        this.showLobbyWait(code);
        this.netStatus('CONTACTING SERVER…');
        this.peer = new Peer(ROOM_PREFIX + code);
        this.peer.on('open', () => this.netStatus('WAITING FOR OPPONENT…'));
        this.peer.on('error', e => {
            if (e.type === 'unavailable-id') { this.destroyNet(); this.createRoom(this.makeCode()); }
            else this.netStatus('ERROR: ' + e.type.toUpperCase());
        });
        this.peer.on('connection', c => {
            if (this.conn) { try { c.close(); } catch (err) {} return; }
            this.conn = c;
            this.bindConn();
            this.netStatus('OPPONENT CONNECTED — PREPARING…');
        });
    }
    joinRoom(code) {
        const g = this.g;
        g.prepareSession();
        this.mode = 'online';
        this.isHost = false;
        this.roomCode = code;
        this.showLobbyWait(code);
        this.netStatus('CONTACTING SERVER…');
        this.peer = new Peer();
        this.peer.on('open', () => {
            this.conn = this.peer.connect(ROOM_PREFIX + code, { reliable: true });
            this.bindConn();
            this.netStatus('CONNECTING…');
        });
        this.peer.on('error', e => this.netStatus(e.type === 'peer-unavailable' ? 'ROOM NOT FOUND — CHECK CODE' : 'ERROR: ' + e.type.toUpperCase()));
    }
    bindConn() {
        this.conn.on('open', () => {
            this.connOpen = true;
            this.sendMsg({ t: 'hello', name: this.myName });
            this.announceLoaded();
            if (!this.isHost) this.netStatus(this.assetsReady ? 'CONNECTED — WAITING FOR HOST…' : 'CONNECTED — LOADING ASSETS…');
        });
        this.conn.on('data', m => this.onMsg(m));
        this.conn.on('close', () => this.onDisconnected());
        this.conn.on('error', () => this.onDisconnected());
    }
    onDisconnected() {
        if (this.phase === 'lobby') { this.netStatus('CONNECTION LOST'); return; }
        if (this.phase === 'over') {
            this.connOpen = false;
            this.opponentLeft = true;
            this.dom.rematchStatus.textContent = 'OPPONENT LEFT — RETURN TO LOBBY';
            return;
        }
        this.connOpen = false;
        this.dom.dc.style.display = 'flex';
    }
    exitToLobby() {
        this.destroyNet();
        this.showLobbyMenu();
    }
    onMsg(m) {
        try {
            if (!m || typeof m !== 'object') return;
            const g = this.g;
            switch (m.t) {
                case 'hello':
                    this.foeName = String(m.name || 'FOE').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 10) || 'FOE';
                    this.addRecent(this.foeName);
                    break;
                case 'loaded':
                    this.peerLoaded = true;
                    if (this.isHost) this.tryHostStart();
                    break;
                case 'start':
                    this.mode = 'online';
                    this.beginCountdown();
                    break;
                case 'state':
                    if (this.remote) {
                        this.remote.targetPos.set(m.x, 0, m.z);
                        this.remote.targetYaw = m.yaw;
                        this.remote.pitch = m.pitch;
                        this.remote.anim = m.anim;
                    }
                    break;
                case 'shot': {
                    this.remote.gunKick = 1;
                    this.remoteFlash.intensity = 5;
                    const dir = new THREE.Vector3(m.dx, m.dy, m.dz).normalize();
                    const origin = new THREE.Vector3(m.ox, m.oy, m.oz);
                    const solid = g.raySolid(origin, dir, 110);
                    this.spawnTracer(origin, dir, (solid ? origin.distanceTo(solid) : 110) / 95);
                    const sp = g.spatial(this.remote.pos);
                    g.sfx.shotAt(sp.vol, sp.pan);
                    break;
                }
                case 'hit': this.takeHit(m.part, m.dmg); break;
                case 'die':
                    this.myKills++;
                    this.remote.dead = true;
                    this.remote.fallT = 0;
                    g.banner('+1 KILL', this.myKills + ' / ' + KILLS_TO_WIN);
                    g.hitmark(true);
                    if (this.myKills >= KILLS_TO_WIN) this.showOver(true);
                    break;
                case 'respawn':
                    this.remote.dead = false;
                    this.remote.fallT = 0;
                    this.remote.g.rotation.x = 0;
                    break;
                case 'rematch':
                    this.theirRematch = true;
                    this.checkRematch();
                    break;
                case 'leave':
                    this.opponentLeft = true;
                    if (this.phase === 'over') this.dom.rematchStatus.textContent = 'OPPONENT LEFT — RETURN TO LOBBY';
                    break;
            }
        } catch (e) {}
    }

    /* ---------- REMOTE PLAYER ---------- */
    updateRemote(dt) {
        const r = this.remote;
        if (!r) return;
        const g = this.g;
        if (r.targetPos && r.targetPos.distanceTo(r.pos) > 8) { r.pos.copy(r.targetPos); r.yaw = r.targetYaw; }
        else {
            r.pos.lerp(r.targetPos, 1 - Math.exp(-12 * dt));
            r.yaw = lerpAngle(r.yaw, r.targetYaw, Math.min(1, dt * 10));
        }
        r.pos.y = g.getTerrainHeight(r.pos.x, r.pos.z);
        r.g.position.copy(r.pos);
        r.g.rotation.y = r.yaw;
        if (r.mixer && !r.dead) r.mixer.update(dt);
        if (r.actions) this.setAnim(r, r.dead ? 'idle' : r.anim);
        if (r.dead) {
            if (r.fallT < 0.5) {
                r.fallT += dt;
                const q = Math.min(1, r.fallT / 0.5);
                r.g.rotation.x = -(q * q) * Math.PI / 2 * 0.96;
            }
        } else {
            r.g.rotation.x = 0;
            const p = clamp(-r.pitch, -0.8, 0.8);
            if (r.head) r.head.rotation.x = p * 0.35;
        }
        if (r.gunKick > 0) {
            r.gunKick = Math.max(0, r.gunKick - dt * 8);
            // muzzle flash glow follows the rifle
            if (r.muzzle) {
                r.g.updateMatrixWorld(true);
                r.muzzle.getWorldPosition(_ta);
                this.remoteFlash.position.copy(_ta);
                this.remoteGlow.position.copy(_ta);
            }
        }
        this.remoteFlash.intensity = Math.max(0, this.remoteFlash.intensity - dt * 50);
        this.remoteGlow.visible = this.remoteFlash.intensity > 1.5;
        if (this.remoteGlow.visible) this.remoteGlow.rotation.x += dt * 20;
    }

    /* ---------- PRESENCE + INVITES ---------- */
    getRecent() {
        try { const a = JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); return Array.isArray(a) ? a.filter(n => typeof n === 'string').slice(0, 6) : []; } catch (e) { return []; }
    }
    addRecent(name) {
        if (!name || name === 'PLAYER' || name === this.myName) return;
        let a = this.getRecent().filter(n => n !== name);
        a.unshift(name);
        a = a.slice(0, 6);
        try { localStorage.setItem(LS_RECENT, JSON.stringify(a)); } catch (e) {}
        this.renderRecent(null);
    }
    presenceId(name) { return PRES_PREFIX + String(name).toLowerCase().replace(/[^a-z0-9]/g, ''); }
    startPresence() {
        this.stopPresence();
        try {
            this.presencePeer = new Peer(this.presenceId(this.myName));
            this.presencePeer.on('open', () => { this.presenceReady = true; });
            this.presencePeer.on('connection', c => {
                c.on('data', m => { try { if (m && m.t === 'invite') this.handleIncomingInvite(c, m); } catch (e) {} });
                c.on('error', () => {});
            });
            this.presencePeer.on('error', err => {
                if (err && err.type === 'peer-unavailable') {
                    if (this.probeResolve) { const r = this.probeResolve; this.probeResolve = null; r(false); }
                    if (this.inviteActive && this.inviteTargetId && String(err.message || '').includes(this.inviteTargetId)) this.cancelPendingInvite('PLAYER OFFLINE');
                }
            });
        } catch (e) { this.presencePeer = null; }
    }
    stopPresence() {
        try { if (this.presencePeer) this.presencePeer.destroy(); } catch (e) {}
        this.presencePeer = null; this.presenceReady = false; this.probeResolve = null;
    }
    probeOnline(name, cb) {
        if (!this.presenceReady || !this.presencePeer) { cb(false); return; }
        let done = false, conn = null, timer = null;
        const finish = ok => {
            if (done) return;
            done = true;
            if (this.probeResolve === finish) this.probeResolve = null;
            clearTimeout(timer);
            try { if (conn) conn.close(); } catch (e) {}
            cb(ok);
        };
        timer = setTimeout(() => finish(false), 5000);
        this.probeResolve = finish;
        try {
            conn = this.presencePeer.connect(this.presenceId(name), { reliable: true });
            conn.on('open', () => finish(true));
            conn.on('error', () => finish(false));
        } catch (e) { finish(false); }
    }
    renderRecent(states) {
        const list = this.dom.recentList;
        if (!list) return;
        const names = this.getRecent();
        if (!names.length) { list.innerHTML = '<div class="rp-empty">NO RECENT DUELS</div>'; return; }
        let html = '';
        for (const n of names) {
            const st = states && states[n] !== undefined ? states[n] : null;
            const cls = st === null ? 'unk' : st ? 'on' : 'off';
            const label = st === null ? '...' : st ? 'DUEL' : 'OFFLINE';
            html += '<div class="rp-row' + (st === true ? ' link' : '') + '" data-nm="' + n + '"><span class="rp-dot ' + cls + '"></span><span class="nm">' + n + '</span><span class="rp-st">' + label + '</span></div>';
        }
        list.innerHTML = html;
        list.querySelectorAll('.rp-row.link').forEach(r => r.addEventListener('click', () => this.sendInvite(r.getAttribute('data-nm'))));
    }
    refreshRecent() {
        if (this.refreshing) return;
        this.renderRecent(null);
        const names = this.getRecent();
        if (!names.length) return;
        this.refreshing = true;
        const states = {};
        let i = 0;
        const next = () => {
            if (i >= names.length) { this.refreshing = false; return; }
            const n = names[i];
            this.probeOnline(n, ok => {
                states[n] = ok;
                this.renderRecent(states);
                i++;
                next();
            });
        };
        next();
    }
    sendInvite(name) {
        if (this.inviteActive) { this.setInviteStatus('INVITE ALREADY PENDING'); return; }
        if (this.phase !== 'lobby' || this.peer || this.conn) { this.setInviteStatus('BUSY'); return; }
        if (!this.presenceReady || !this.presencePeer) { this.setInviteStatus('PRESENCE NOT READY — RETRY'); return; }
        const code = this.makeCode();
        this.inviteActive = true;
        this.inviteTargetId = this.presenceId(name);
        this.setInviteStatus('INVITING ' + name + '…');
        this.mode = 'online';
        this.isHost = true;
        this.roomCode = code;
        this.showLobbyWait(code);
        this.netStatus('WAITING FOR OPPONENT…');
        this.peer = new Peer(ROOM_PREFIX + code);
        this.peer.on('error', () => { if (this.inviteActive) this.cancelPendingInvite('ROOM ERROR — TRY AGAIN'); });
        this.peer.on('connection', c => {
            if (this.conn) { try { c.close(); } catch (e) {} return; }
            this.conn = c;
            this.bindConn();
        });
        this.inviteTimer = setTimeout(() => this.cancelPendingInvite('NO RESPONSE'), 30000);
        try {
            this.inviteConn = this.presencePeer.connect(this.inviteTargetId, { reliable: true });
            this.inviteConn.on('open', () => {
                try { this.inviteConn.send({ t: 'invite', name: this.myName, code: code }); }
                catch (e) { this.cancelPendingInvite('FAILED TO SEND'); }
            });
            this.inviteConn.on('data', m => {
                try {
                    if (!m || !this.inviteActive) return;
                    if (m.t === 'accept') {
                        this.inviteActive = false;
                        this.inviteTargetId = null;
                        clearTimeout(this.inviteTimer);
                        try { this.inviteConn.close(); } catch (e) {}
                        this.inviteConn = null;
                        this.setInviteStatus('ACCEPTED — STARTING');
                        this.netStatus(name + ' ACCEPTED — WAITING…');
                    } else if (m.t === 'decline') this.cancelPendingInvite('INVITE DECLINED');
                    else if (m.t === 'busy') this.cancelPendingInvite(name + ' IS BUSY');
                } catch (e) {}
            });
            this.inviteConn.on('error', () => this.cancelPendingInvite('CONNECTION FAILED'));
            this.inviteConn.on('close', () => { if (this.inviteActive) this.cancelPendingInvite('NO RESPONSE'); });
        } catch (e) { this.cancelPendingInvite('FAILED'); }
    }
    handleIncomingInvite(c, m) {
        const from = String(m.name || '').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 10) || 'PLAYER';
        const code = String(m.code || '').toLowerCase();
        if (!code || code.length < 4) return;
        if (this.phase !== 'lobby' || this.peer || this.conn || this.pendingInvite || this.inviteActive) {
            try { c.send({ t: 'busy' }); } catch (e) {}
            setTimeout(() => { try { c.close(); } catch (e) {} }, 150);
            return;
        }
        this.pendingInvite = c;
        this.pendingInviteCode = code;
        this.dom.inviteFrom.textContent = from;
        this.dom.inviteModal.style.display = 'flex';
        c.on('close', () => { if (this.pendingInvite === c) this.respondInvite(false); });
        this.pendingInviteTimer = setTimeout(() => this.respondInvite(false), 30000);
    }
    respondInvite(accept) {
        if (!this.pendingInvite) return;
        const c = this.pendingInvite, code = this.pendingInviteCode;
        this.pendingInvite = null;
        clearTimeout(this.pendingInviteTimer);
        this.dom.inviteModal.style.display = 'none';
        try { c.send({ t: accept ? 'accept' : 'decline' }); } catch (e) {}
        setTimeout(() => { try { c.close(); } catch (e) {} }, 200);
        if (accept) {
            this.dom.codeInput.value = code;
            setTimeout(() => this.joinRoom(code), 700);
        }
    }
    cancelPendingInvite(msg) {
        if (!this.inviteActive) { this.setInviteStatus(msg || ''); return; }
        this.inviteActive = false;
        this.inviteTargetId = null;
        clearTimeout(this.inviteTimer);
        try { if (this.inviteConn) this.inviteConn.close(); } catch (e) {}
        this.inviteConn = null;
        if (!this.conn) this.destroyNet();
        this.setInviteStatus(msg || '');
    }

    /* ---------- MAIN UPDATE ---------- */
    update(dt) {
        const g = this.g;
        if (this.phase === 'countdown') {
            this.countT -= dt;
            const n = Math.max(1, Math.ceil(this.countT));
            if (n !== this.lastCount) {
                this.lastCount = n;
                this.dom.countNum.textContent = n;
                this.dom.countNum.classList.remove('pop');
                void this.dom.countNum.offsetWidth;
                this.dom.countNum.classList.add('pop');
                g.sfx.beep(false);
            }
            if (this.countT <= 0) this.startFight();
        }
        if (this.mode === 'offline') {
            for (let i = this.enemies.length - 1; i >= 0; i--) this.updateEnemy(this.enemies[i], dt);
        }
        if (this.mode === 'online') {
            this.updateRemote(dt);
            if (g.state.dead && this.phase === 'fight') {
                this.respawnT -= dt;
                if (this.respawnT <= 0) this.respawnLocal();
            }
            if (this.connOpen && this.phase !== 'lobby') {
                this.netAcc += dt;
                if (this.netAcc >= 0.066) {
                    this.netAcc = 0;
                    const s = g.getLocalState();
                    this.sendMsg({ t: 'state', x: s.x, z: s.z, yaw: s.yaw, pitch: s.pitch, anim: s.anim });
                }
            }
        }
        for (let i = this.tracers.length - 1; i >= 0; i--) {
            const t = this.tracers[i];
            t.mesh.position.addScaledVector(t.dir, 95 * dt);
            t.life -= dt;
            if (t.life <= 0) { g.scene.remove(t.mesh); this.tracers.splice(i, 1); }
        }
        this.updateDmgNums(dt);
        // presence auto-refresh in lobby
        if (this.phase === 'lobby') {
            this.presTimer -= dt;
            if (this.presTimer <= 0) { this.presTimer = 30; this.refreshRecent(); }
        }
    }
}
