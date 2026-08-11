"use strict";

const DATA_URL = new URL("./trainer_v3_data.json", document.baseURI).href;
const STORAGE_PREFIX = "englishStoryWorkspace:v3:The_Plains_Zebra:A1_A2";
let data;
let selectedIndex = 0;
let playingIndex = -1;
let storyMode = false;
let audio = new Audio();
let playbackToken = 0;
let storyPlaybackState = "idle";
let learningSourceIndex = 0;
let learningScrollY = 0;
let learningFocusElement = null;
let currentLexicalItem = null;
let vocabulary = new Set();
let builderIndex = 0;
let builderMode = null;
let builderBank = [];
let builderAnswer = [];
let builderProgress = { sentences: {} };

const $ = (id) => document.getElementById(id);
const sentenceList = $("sentenceList");
const lexicalDialog = $("lexicalDialog");
const deepDialog = $("deepStudyDialog");
const vocabularyDialog = $("vocabularyDialog");
const builderDialog = $("builderDialog");

function trackTrainerEvent(eventName, eventData = {}) {
  const allowed = new Set([
    "trainer_open", "full_audio_started", "full_audio_paused", "full_audio_completed",
    "sentence_selected", "lexical_item_opened", "vocabulary_item_added",
    "vocabulary_opened", "vocabulary_item_reviewed", "deep_study_opened",
    "phrase_audio_played", "sentence_builder_opened", "builder_mode_selected",
    "builder_audio_played", "builder_translation_revealed", "builder_segment_selected",
    "builder_answer_checked", "builder_answer_correct", "builder_answer_incorrect",
    "builder_progress_reset", "sentence_milestone_reached", "workspace_completed"
  ]);
  if (!allowed.has(eventName)) throw new Error(`Unsupported trainer event: ${eventName}`);
  console.info("[TrainerV3Event]", eventName, { ...eventData, workspace: true });
}

function storageKey() {
  return `${STORAGE_PREFIX}:${data.content_revision}:uk-UA:vocabulary`;
}

function builderStorageKey() {
  return `${STORAGE_PREFIX}:${data.content_revision}:uk-UA:sentence-builder`;
}

function emptyBuilderRecord() {
  return { completed_modes: [], attempt_count: 0, translation_revealed: false };
}

function loadBuilderProgress() {
  try {
    const parsed = JSON.parse(localStorage.getItem(builderStorageKey()) || "{\"sentences\":{}}");
    builderProgress = parsed && typeof parsed.sentences === "object" ? { sentences: parsed.sentences } : { sentences: {} };
  } catch (_) {
    builderProgress = { sentences: {} };
  }
}

function saveBuilderProgress() {
  try { localStorage.setItem(builderStorageKey(), JSON.stringify(builderProgress)); } catch (_) {}
  renderBuilderSentenceMenu();
}

function builderRecord(scene = data.sentences[builderIndex]) {
  if (!builderProgress.sentences[scene.sentence_id]) builderProgress.sentences[scene.sentence_id] = emptyBuilderRecord();
  return builderProgress.sentences[scene.sentence_id];
}

function approvedBuilderSegments(scene) {
  return scene.deep_study_blocks.map((block) => ({ id: block.english_id, text: block.english }));
}

function reconstructSegments(segments) {
  return segments.map((segment) => segment.text).join(" ");
}

function completedBuilderSentenceCount() {
  return data.sentences.filter((scene) => (builderProgress.sentences[scene.sentence_id]?.completed_modes || []).length > 0).length;
}

function shuffledSegments(scene) {
  const canonical = approvedBuilderSegments(scene);
  const shuffled = [...canonical];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const random = globalThis.crypto?.getRandomValues ? crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296 : Math.random();
    const swap = Math.floor(random * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  if (shuffled.every((segment, index) => segment.id === canonical[index].id)) shuffled.reverse();
  return shuffled;
}

function loadVocabulary() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey()) || "[]");
    vocabulary = new Set(Array.isArray(value) ? value.filter((id) => lexicalMap().has(id)) : []);
  } catch (_) {
    vocabulary = new Set();
  }
}

function saveVocabulary() {
  try { localStorage.setItem(storageKey(), JSON.stringify([...vocabulary])); } catch (_) {}
  updateVocabularyCount();
}

function lexicalMap() {
  const map = new Map();
  data.sentences.forEach((scene) => scene.lexical_items.forEach((item) => map.set(item.item_id, item)));
  return map;
}

function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function totalDuration() {
  return data.sentences.reduce((sum, scene) => sum + scene.duration_seconds, 0);
}

function elapsedDuration(local = 0) {
  return data.sentences.slice(0, Math.max(playingIndex, 0)).reduce((sum, scene) => sum + scene.duration_seconds, 0) + local;
}

function updatePlaybackProgress(local = 0) {
  const elapsed = playingIndex < 0 ? 0 : elapsedDuration(local);
  const total = totalDuration();
  $("storyProgress").value = total ? elapsed / total : 0;
  $("storyTime").textContent = `${formatTime(elapsed)} / ${formatTime(total)}`;
  document.querySelectorAll(".sentence-card").forEach((card, index) => {
    card.classList.toggle("playing", storyMode && index === playingIndex);
  });
}

function keepActiveSentenceVisible(force = false) {
  if (playingIndex < 0) return;
  const card = document.querySelectorAll(".sentence-card")[playingIndex];
  if (!card) return;
  const rect = card.getBoundingClientRect();
  if (!force && rect.top >= window.innerHeight * .18 && rect.bottom <= window.innerHeight * .78) return;
  card.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
}

function stopAllAudioBeforeLearning() {
  playbackToken += 1;
  storyPlaybackState = "learning";
  storyMode = false;
  playingIndex = -1;
  const staleAudio = audio;
  staleAudio.onplay = null;
  staleAudio.onpause = null;
  staleAudio.ontimeupdate = null;
  staleAudio.onended = null;
  staleAudio.onerror = null;
  staleAudio.pause();
  try { staleAudio.currentTime = 0; } catch (_) {}
  try { staleAudio.removeAttribute("src"); staleAudio.load(); } catch (_) {}
  updatePlaybackProgress(0);
  return playbackToken;
}

function playFile(source, eventName = null, eventData = {}) {
  const token = stopAllAudioBeforeLearning();
  $("playerStatus").textContent = `Ready at Sentence ${selectedIndex + 1}`;
  const nextAudio = new Audio(source.path);
  audio = nextAudio;
  nextAudio.play().then(() => {
    if (token !== playbackToken) { nextAudio.pause(); return; }
    if (eventName) trackTrainerEvent(eventName, eventData);
  }).catch(() => {});
}

function playStoryFrom(index) {
  const token = stopAllAudioBeforeLearning();
  if (index >= data.sentences.length) {
    storyPlaybackState = "complete";
    storyMode = false;
    playingIndex = -1;
    $("playerStatus").textContent = `Full ${data.sentence_count}-sentence audio complete`;
    updatePlaybackProgress(totalDuration());
    trackTrainerEvent("full_audio_completed", { sentence_count: data.sentence_count });
    return;
  }
  storyMode = true;
  storyPlaybackState = "playing";
  playingIndex = index;
  selectedIndex = index;
  renderSelection();
  const nextAudio = new Audio(data.sentences[index].english_audio.path);
  audio = nextAudio;
  nextAudio.ontimeupdate = () => { if (token === playbackToken) updatePlaybackProgress(nextAudio.currentTime); };
  nextAudio.onended = () => { if (token === playbackToken) playStoryFrom(index + 1); };
  $("playerStatus").textContent = `Playing Sentence ${index + 1}`;
  updatePlaybackProgress(0);
  keepActiveSentenceVisible(true);
  nextAudio.play().then(() => {
    if (token !== playbackToken) { nextAudio.pause(); return; }
    updatePlaybackProgress(0);
  }).catch(() => {
    if (token !== playbackToken) return;
    storyMode = false;
    storyPlaybackState = "idle";
    $("playerStatus").textContent = `Ready at Sentence ${index + 1}`;
    updatePlaybackProgress(0);
  });
}

function listenToSentence(index) {
  selectSentence(index, true);
  const scene = data.sentences[index];
  const token = stopAllAudioBeforeLearning();
  const nextAudio = new Audio(scene.english_audio.path);
  audio = nextAudio;
  $("playerStatus").textContent = `Listening Again — Sentence ${index + 1}`;
  $("storyProgress").value = 0;
  $("storyTime").textContent = `0:00 / ${formatTime(scene.duration_seconds)}`;
  nextAudio.ontimeupdate = () => {
    if (token !== playbackToken) return;
    $("storyProgress").value = scene.duration_seconds ? nextAudio.currentTime / scene.duration_seconds : 0;
    $("storyTime").textContent = `${formatTime(nextAudio.currentTime)} / ${formatTime(scene.duration_seconds)}`;
  };
  nextAudio.onended = () => {
    if (token !== playbackToken) return;
    $("playerStatus").textContent = `Ready at Sentence ${index + 1}`;
    $("storyProgress").value = 0;
    $("storyTime").textContent = `0:00 / ${formatTime(totalDuration())}`;
  };
  nextAudio.play().then(() => {
    if (token !== playbackToken) nextAudio.pause();
  }).catch(() => {
    if (token !== playbackToken) return;
    $("playerStatus").textContent = `Ready at Sentence ${index + 1}`;
  });
}

function selectSentence(index, alreadyStopped = false) {
  if (!alreadyStopped) stopAllAudioBeforeLearning();
  selectedIndex = index;
  renderSelection();
  $("playerStatus").textContent = `Ready at Sentence ${index + 1}`;
  trackTrainerEvent("sentence_selected", { sentence_id: data.sentences[index].sentence_id, story_order: index + 1 });
}

function rememberLearningContext(index, focusElement = document.activeElement) {
  learningSourceIndex = index;
  learningScrollY = window.scrollY;
  learningFocusElement = focusElement;
  selectedIndex = index;
  renderSelection();
}

function restoreLearningContext() {
  selectedIndex = learningSourceIndex;
  renderSelection();
  window.scrollTo({ top: learningScrollY, behavior: "auto" });
  const card = document.querySelectorAll(".sentence-card")[learningSourceIndex];
  (learningFocusElement?.isConnected ? learningFocusElement : card)?.focus({ preventScroll: true });
  $("playerStatus").textContent = `Ready at Sentence ${learningSourceIndex + 1}`;
}

function closeLearningInterfaces() {
  [lexicalDialog, deepDialog, vocabularyDialog, builderDialog].forEach((dialog) => { if (dialog.open) dialog.close(); });
}

function closeOtherLearningInterfaces(exception) {
  [lexicalDialog, deepDialog, vocabularyDialog, builderDialog].forEach((dialog) => {
    if (dialog !== exception && dialog.open) dialog.close();
  });
}

function returnFromLearning() {
  stopAllAudioBeforeLearning();
  closeLearningInterfaces();
  restoreLearningContext();
}

function continueFromLearning(index = learningSourceIndex) {
  stopAllAudioBeforeLearning();
  closeLearningInterfaces();
  if (index >= data.sentences.length - 1) {
    selectedIndex = data.sentences.length - 1;
    renderSelection();
    storyPlaybackState = "complete";
    $("playerStatus").textContent = `Full ${data.sentence_count}-sentence audio complete`;
    updatePlaybackProgress(totalDuration());
    trackTrainerEvent("full_audio_completed", { sentence_count: data.sentence_count, source: "learning_continue" });
    return;
  }
  playStoryFrom(index + 1);
}

function renderSelection() {
  document.querySelectorAll(".sentence-card").forEach((card, index) => card.classList.toggle("selected", index === selectedIndex));
}

function renderSentenceText(scene) {
  const paragraph = document.createElement("p");
  paragraph.className = "sentence-text";
  paragraph.lang = "en";
  let cursor = 0;
  scene.lexical_items.forEach((item) => {
    if (item.start_offset > cursor) paragraph.append(document.createTextNode(scene.english.slice(cursor, item.start_offset)));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lexical-item";
    button.textContent = scene.english.slice(item.start_offset, item.end_offset);
    button.setAttribute("aria-label", `Open approved phrase: ${item.display_text}`);
    button.addEventListener("click", () => openLexicalItem(item, button));
    paragraph.append(button);
    cursor = item.end_offset;
  });
  if (cursor < scene.english.length) paragraph.append(document.createTextNode(scene.english.slice(cursor)));
  return paragraph;
}

function renderSentences() {
  sentenceList.replaceChildren();
  data.sentences.forEach((scene, index) => {
    const article = document.createElement("article");
    article.className = "sentence-card";
    article.tabIndex = -1;
    article.dataset.sentence = String(scene.story_order);
    article.dataset.sentenceId = scene.sentence_id;
    const number = document.createElement("p");
    number.className = "sentence-number";
    number.textContent = `Sentence ${scene.story_order}`;
    const listen = document.createElement("button");
    listen.type = "button";
    listen.className = "sentence-action listen-button";
    listen.textContent = "Listen Again";
    listen.addEventListener("click", () => listenToSentence(index));
    const study = document.createElement("button");
    study.type = "button";
    study.className = "sentence-action study-button";
    study.textContent = "Study";
    study.addEventListener("click", () => openDeepStudy(index));
    const vocabularyButton = document.createElement("button");
    vocabularyButton.type = "button";
    vocabularyButton.className = "sentence-action inline-vocabulary-button";
    vocabularyButton.textContent = "My Vocabulary";
    vocabularyButton.addEventListener("click", () => openVocabulary(index, vocabularyButton));
    const build = document.createElement("button");
    build.type = "button";
    build.className = "sentence-action build-button";
    build.textContent = "Build";
    build.addEventListener("click", () => openSentenceBuilder(index, true));
    const continueButton = document.createElement("button");
    continueButton.type = "button";
    continueButton.className = "sentence-action continue-button";
    continueButton.textContent = "Continue";
    continueButton.addEventListener("click", () => playStoryFrom(Math.min(index + 1, data.sentences.length)));
    const actions = document.createElement("div");
    actions.className = "sentence-learning-actions";
    actions.append(listen, vocabularyButton, study, build, continueButton);
    article.append(number, renderSentenceText(scene), actions);
    sentenceList.append(article);
  });
  renderSelection();
}

function openLexicalItem(item, focusElement = document.activeElement) {
  stopAllAudioBeforeLearning();
  closeOtherLearningInterfaces(lexicalDialog);
  const index = data.sentences.findIndex((scene) => scene.sentence_id === item.sentence_id);
  rememberLearningContext(index < 0 ? selectedIndex : index, focusElement);
  currentLexicalItem = item;
  $("lexicalEnglish").textContent = item.display_text;
  $("lexicalUkrainian").textContent = item.contextual_translation;
  $("lexicalContext").textContent = item.context_sentence;
  $("lexicalStatus").textContent = vocabulary.has(item.item_id) ? "Already in My Vocabulary" : "";
  $("lexicalAdd").disabled = vocabulary.has(item.item_id);
  $("lexicalOpenVocabulary").hidden = !vocabulary.has(item.item_id);
  lexicalDialog.showModal();
  trackTrainerEvent("lexical_item_opened", { item_id: item.item_id, sentence_id: item.sentence_id, item_type: item.item_type });
}

function addCurrentLexicalItem() {
  stopAllAudioBeforeLearning();
  if (!currentLexicalItem || vocabulary.has(currentLexicalItem.item_id)) return;
  vocabulary.add(currentLexicalItem.item_id);
  saveVocabulary();
  $("lexicalAdd").disabled = true;
  $("lexicalStatus").textContent = "Added to My Vocabulary";
  $("lexicalOpenVocabulary").hidden = false;
  trackTrainerEvent("vocabulary_item_added", { item_id: currentLexicalItem.item_id, sentence_id: currentLexicalItem.sentence_id });
}

function updateVocabularyCount() {
  $("vocabularyCount").textContent = String(vocabulary.size);
}

function renderVocabulary() {
  const map = lexicalMap();
  const list = $("vocabularyList");
  list.replaceChildren();
  $("vocabularyEmpty").hidden = vocabulary.size > 0;
  $("vocabularyClear").disabled = vocabulary.size === 0;
  vocabulary.forEach((id) => {
    const item = map.get(id);
    if (!item) return;
    const details = document.createElement("details");
    details.className = "vocabulary-entry";
    const summary = document.createElement("summary");
    summary.textContent = item.display_text;
    const body = document.createElement("div");
    body.className = "vocabulary-detail";
    const translation = document.createElement("p");
    translation.className = "translation";
    translation.lang = "uk";
    translation.textContent = item.contextual_translation;
    const context = document.createElement("p");
    context.textContent = item.context_sentence;
    const pronounce = document.createElement("button");
    pronounce.type = "button";
    pronounce.textContent = "Pronounce English";
    pronounce.addEventListener("click", () => playFile(item.audio_source));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      stopAllAudioBeforeLearning();
      vocabulary.delete(id);
      saveVocabulary();
      renderVocabulary();
    });
    details.addEventListener("toggle", () => {
      if (details.open) {
        stopAllAudioBeforeLearning();
        trackTrainerEvent("vocabulary_item_reviewed", { item_id: item.item_id, sentence_id: item.sentence_id });
      }
    });
    body.append(translation, context, pronounce, document.createTextNode(" "), remove);
    details.append(summary, body);
    list.append(details);
  });
}

function updateVocabularyContextActions() {
  const sceneNumber = learningSourceIndex + 1;
  $("vocabularyReturn").textContent = `Return to Sentence ${sceneNumber}`;
  $("vocabularyContinue").textContent = sceneNumber === data.sentences.length ? "Finish Story" : `Continue with Sentence ${sceneNumber + 1}`;
}

function openVocabulary(index = selectedIndex, focusElement = document.activeElement) {
  stopAllAudioBeforeLearning();
  closeOtherLearningInterfaces(vocabularyDialog);
  rememberLearningContext(index, focusElement);
  renderVocabulary();
  updateVocabularyContextActions();
  if (lexicalDialog.open) lexicalDialog.close();
  vocabularyDialog.showModal();
  trackTrainerEvent("vocabulary_opened", { item_count: vocabulary.size, source_sentence_id: data.sentences[index].sentence_id });
}

function clearVocabularyWithConfirmation(confirmAction = window.confirm) {
  if (!vocabulary.size || !confirmAction("Clear all items from My Vocabulary?")) return false;
  vocabulary.clear();
  saveVocabulary();
  renderVocabulary();
  return true;
}

function renderDeepStudy(index) {
  selectedIndex = index;
  renderSelection();
  const scene = data.sentences[index];
  $("deepSentencePicker").value = String(index);
  $("deepTitle").textContent = `Study Sentence ${scene.story_order}`;
  $("deepEnglish").textContent = scene.english;
  $("deepUkrainian").textContent = scene.ukrainian;
  const blocks = $("deepBlocks");
  blocks.replaceChildren();
  const studyRows = Math.max(scene.deep_study_blocks.length, scene.ukrainian_study_blocks.length);
  for (let rowIndex = 0; rowIndex < studyRows; rowIndex += 1) {
    const block = scene.deep_study_blocks[rowIndex];
    const ukrainianBlock = scene.ukrainian_study_blocks[rowIndex];
    const card = document.createElement("article");
    card.className = "deep-block";
    const english = document.createElement("strong");
    english.lang = "en";
    english.textContent = block ? `${block.position}. ${block.english}` : "";
    const ukrainian = document.createElement("p");
    ukrainian.lang = "uk";
    ukrainian.textContent = ukrainianBlock ? `${ukrainianBlock.position}. ${ukrainianBlock.ukrainian}` : "";
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    if (block) {
    const enAudio = document.createElement("button");
    enAudio.type = "button";
    enAudio.textContent = "Play English phrase";
    enAudio.addEventListener("click", () => playFile(block.english_audio, "phrase_audio_played", { sentence_id: scene.sentence_id, block_id: block.english_id, language: "en" }));
      actions.append(enAudio);
    }
    if (ukrainianBlock) {
    const uaAudio = document.createElement("button");
    uaAudio.type = "button";
    uaAudio.className = "secondary";
    uaAudio.textContent = "Play Ukrainian phrase";
    uaAudio.addEventListener("click", () => playFile(ukrainianBlock.ukrainian_audio, "phrase_audio_played", { sentence_id: scene.sentence_id, block_id: ukrainianBlock.ukrainian_id, language: "uk-UA" }));
      actions.append(uaAudio);
    }
    card.append(english, ukrainian, actions);
    blocks.append(card);
  }
}

function openDeepStudy(index) {
  stopAllAudioBeforeLearning();
  closeOtherLearningInterfaces(deepDialog);
  rememberLearningContext(index);
  renderDeepStudy(index);
  deepDialog.showModal();
  trackTrainerEvent("deep_study_opened", { sentence_id: data.sentences[index].sentence_id, story_order: index + 1 });
}

function renderBuilderSentenceMenu() {
  if (!data) return;
  const menu = $("builderSentenceMenu");
  menu.replaceChildren();
  data.sentences.forEach((scene, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "builder-sentence-choice";
    button.classList.toggle("active", index === builderIndex);
    const completed = builderProgress.sentences[scene.sentence_id]?.completed_modes || [];
    button.textContent = `Sentence ${scene.story_order}${completed.length ? ` · ${completed.length}/2` : ""}`;
    button.setAttribute("aria-pressed", String(index === builderIndex));
    button.addEventListener("click", () => chooseBuilderSentence(index));
    menu.append(button);
  });
}

function resetBuilderRound() {
  const scene = data.sentences[builderIndex];
  builderBank = shuffledSegments(scene);
  builderAnswer = [];
  $("builderResult").textContent = "";
  $("builderResult").className = "builder-result";
  $("builderTryAgain").hidden = true;
  $("builderPlayAgain").hidden = true;
  $("builderCheck").hidden = false;
  renderBuilderSegments();
}

function chooseBuilderSentence(index) {
  if (builderDialog.open) {
    stopAllAudioBeforeLearning();
    learningSourceIndex = index;
  }
  builderIndex = index;
  builderMode = null;
  $("builderTitle").textContent = `Build Sentence ${data.sentences[index].story_order}`;
  $("builderModeChoice").hidden = false;
  $("builderWorkspace").hidden = true;
  renderBuilderSentenceMenu();
}

function openSentenceBuilder(index = 0, direct = false) {
  stopAllAudioBeforeLearning();
  closeOtherLearningInterfaces(builderDialog);
  rememberLearningContext(index);
  builderIndex = index;
  loadBuilderProgress();
  chooseBuilderSentence(index);
  builderDialog.showModal();
  trackTrainerEvent("sentence_builder_opened", {
    sentence_id: data.sentences[index].sentence_id,
    story_order: index + 1,
    source: direct ? "sentence_action" : "global"
  });
}

function selectBuilderMode(mode) {
  stopAllAudioBeforeLearning();
  builderMode = mode;
  const scene = data.sentences[builderIndex];
  $("builderModeChoice").hidden = true;
  $("builderWorkspace").hidden = false;
  $("builderModeLabel").textContent = mode === "translation" ? "Translation Mode" : "Listening Mode";
  $("builderTranslation").textContent = scene.ukrainian;
  $("builderTranslation").hidden = mode === "listening";
  $("builderShowTranslation").hidden = mode !== "listening";
  $("builderAudioStatus").textContent = "";
  resetBuilderRound();
  trackTrainerEvent("builder_mode_selected", { sentence_id: scene.sentence_id, mode });
}

function makeSegmentButton(segment, location, index) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `builder-segment ${location}`;
  button.textContent = segment.text;
  button.draggable = true;
  button.dataset.segmentId = segment.id;
  button.dataset.location = location;
  button.dataset.index = String(index);
  button.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", JSON.stringify({ location, index }));
    event.dataTransfer.effectAllowed = "move";
  });
  button.addEventListener("click", () => {
    if (location === "bank") moveBankSegmentToAnswer(index);
    else moveAnswerSegmentToBank(index);
  });
  return button;
}

function renderBuilderSegments() {
  const bank = $("builderSegmentBank");
  const answer = $("builderAnswer");
  bank.replaceChildren(...builderBank.map((segment, index) => makeSegmentButton(segment, "bank", index)));
  answer.replaceChildren();
  if (!builderAnswer.length) {
    const empty = document.createElement("p");
    empty.id = "builderEmpty";
    empty.className = "builder-empty";
    empty.textContent = "Select or drag segments here.";
    answer.append(empty);
  } else {
    builderAnswer.forEach((segment, index) => answer.append(makeSegmentButton(segment, "answer", index)));
  }
}

function moveBankSegmentToAnswer(index, targetIndex = builderAnswer.length) {
  const [segment] = builderBank.splice(index, 1);
  if (!segment) return;
  builderAnswer.splice(Math.max(0, Math.min(targetIndex, builderAnswer.length)), 0, segment);
  renderBuilderSegments();
  trackTrainerEvent("builder_segment_selected", { sentence_id: data.sentences[builderIndex].sentence_id, segment_id: segment.id, action: "placed" });
}

function moveAnswerSegmentToBank(index) {
  const [segment] = builderAnswer.splice(index, 1);
  if (!segment) return;
  builderBank.push(segment);
  renderBuilderSegments();
  trackTrainerEvent("builder_segment_selected", { sentence_id: data.sentences[builderIndex].sentence_id, segment_id: segment.id, action: "removed" });
}

function handleBuilderDrop(event, targetLocation) {
  event.preventDefault();
  let transfer;
  try { transfer = JSON.parse(event.dataTransfer.getData("text/plain")); } catch (_) { return; }
  const target = event.target.closest(".builder-segment");
  const targetIndex = target ? Number(target.dataset.index) : (targetLocation === "answer" ? builderAnswer.length : builderBank.length);
  if (transfer.location === "bank" && targetLocation === "answer") moveBankSegmentToAnswer(transfer.index, targetIndex);
  else if (transfer.location === "answer" && targetLocation === "bank") moveAnswerSegmentToBank(transfer.index);
  else if (transfer.location === "answer" && targetLocation === "answer") {
    const [segment] = builderAnswer.splice(transfer.index, 1);
    if (!segment) return;
    const adjusted = transfer.index < targetIndex ? targetIndex - 1 : targetIndex;
    builderAnswer.splice(Math.max(0, adjusted), 0, segment);
    renderBuilderSegments();
    trackTrainerEvent("builder_segment_selected", { sentence_id: data.sentences[builderIndex].sentence_id, segment_id: segment.id, action: "moved" });
  }
}

function playBuilderAudio() {
  const scene = data.sentences[builderIndex];
  playFile(scene.english_audio, "builder_audio_played", { sentence_id: scene.sentence_id, mode: builderMode });
  $("builderAudioStatus").textContent = "Playing approved sentence audio";
}

function revealBuilderTranslation() {
  const scene = data.sentences[builderIndex];
  $("builderTranslation").hidden = false;
  $("builderShowTranslation").hidden = true;
  builderRecord(scene).translation_revealed = true;
  saveBuilderProgress();
  trackTrainerEvent("builder_translation_revealed", { sentence_id: scene.sentence_id, mode: builderMode, hint: true });
}

function checkBuilderAnswer() {
  const scene = data.sentences[builderIndex];
  const record = builderRecord(scene);
  record.attempt_count += 1;
  const submitted = reconstructSegments(builderAnswer);
  const correct = builderAnswer.length === scene.deep_study_blocks.length && submitted === scene.builder_canonical_answer;
  trackTrainerEvent("builder_answer_checked", { sentence_id: scene.sentence_id, mode: builderMode, attempt_count: record.attempt_count, correct });
  if (correct) {
    const newlyCompletedMode = !record.completed_modes.includes(builderMode);
    if (newlyCompletedMode) record.completed_modes.push(builderMode);
    $("builderResult").textContent = "Correct — you built the complete sentence.";
    $("builderResult").className = "builder-result correct";
    $("builderCheck").hidden = true;
    $("builderPlayAgain").hidden = false;
    trackTrainerEvent("builder_answer_correct", { sentence_id: scene.sentence_id, mode: builderMode, attempt_count: record.attempt_count });
    if (newlyCompletedMode) {
      const completed = completedBuilderSentenceCount();
      if (completed % 5 === 0 || completed === data.sentence_count) {
        trackTrainerEvent("sentence_milestone_reached", { completed_sentence_count: completed, sentence_count: data.sentence_count });
      }
      if (completed === data.sentence_count) {
        trackTrainerEvent("workspace_completed", { content_revision: data.content_revision, sentence_count: data.sentence_count });
      }
    }
  } else {
    $("builderResult").textContent = "Not correct yet. Try again or reset the segments.";
    $("builderResult").className = "builder-result incorrect";
    $("builderTryAgain").hidden = false;
    trackTrainerEvent("builder_answer_incorrect", { sentence_id: scene.sentence_id, mode: builderMode, attempt_count: record.attempt_count });
  }
  saveBuilderProgress();
}

function resetBuilderProgressWithConfirmation(confirmAction = window.confirm) {
  if (!confirmAction(`Reset all Sentence Builder progress for Sentences 1–${data.sentence_count}?`)) return false;
  builderProgress = { sentences: {} };
  try { localStorage.removeItem(builderStorageKey()); } catch (_) {}
  renderBuilderSentenceMenu();
  resetBuilderRound();
  trackTrainerEvent("builder_progress_reset", { sentence_count: data.sentence_count });
  return true;
}

function closeDialog(dialog) {
  stopAllAudioBeforeLearning();
  dialog.close();
  restoreLearningContext();
}

async function start() {
  const response = await fetch(DATA_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Trainer data failed to load: ${response.status}`);
  data = await response.json();
  const derivedEnglishSegments = data.sentences.reduce((sum, sentence) => sum + sentence.deep_study_blocks.length, 0);
  const derivedUkrainianSegments = data.sentences.reduce((sum, sentence) => sum + sentence.ukrainian_study_blocks.length, 0);
  const derivedLexicalItems = data.sentences.reduce((sum, sentence) => sum + sentence.lexical_items.length, 0);
  if (data.sentences.length !== data.sentence_count || derivedEnglishSegments !== data.english_phrase_segment_count || derivedUkrainianSegments !== data.ukrainian_phrase_segment_count || derivedLexicalItems !== data.supported_lexical_item_count) throw new Error("Full Workspace data contract failed");
  $("workspaceMeta").textContent = `A1–A2 · English Story Workspace · ${data.sentence_count} sentences`;
  $("storyTitle").textContent = `The complete ${data.sentence_count}-sentence story`;
  renderSentences();
  data.sentences.forEach((scene, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `Sentence ${scene.story_order}`;
    $("deepSentencePicker").append(option);
  });
  loadVocabulary();
  loadBuilderProgress();
  updateVocabularyCount();
  $("storyTime").textContent = `0:00 / ${formatTime(totalDuration())}`;
  trackTrainerEvent("trainer_open", { content_revision: data.content_revision, sentence_count: data.sentence_count, target_language: data.target_language });
}

$("playStory").addEventListener("click", () => {
  if (storyMode && audio.src && audio.paused && playingIndex >= 0) {
    const resumeToken = playbackToken;
    const resumedAudio = audio;
    resumedAudio.play().then(() => {
      if (resumeToken !== playbackToken) { resumedAudio.pause(); return; }
      storyPlaybackState = "playing";
      $("playerStatus").textContent = `Playing Sentence ${playingIndex + 1}`;
      trackTrainerEvent("full_audio_started", { start_sentence_id: data.sentences[playingIndex].sentence_id, resumed: true });
      updatePlaybackProgress(audio.currentTime);
    }).catch(() => {});
  } else {
    const startIndex = selectedIndex;
    playStoryFrom(startIndex);
    trackTrainerEvent("full_audio_started", { start_sentence_id: data.sentences[startIndex].sentence_id, resumed: false });
  }
});
$("pauseStory").addEventListener("click", () => {
  if (!storyMode || audio.paused) return;
  audio.pause();
  storyPlaybackState = "paused";
  $("playerStatus").textContent = `Paused at Sentence ${playingIndex + 1}`;
  updatePlaybackProgress(audio.currentTime);
  trackTrainerEvent("full_audio_paused", { sentence_id: data.sentences[playingIndex].sentence_id });
});
$("restartStory").addEventListener("click", () => {
  selectedIndex = 0;
  playStoryFrom(0);
  trackTrainerEvent("full_audio_started", { start_sentence_id: data.sentences[0].sentence_id, restarted: true });
});
$("lexicalClose").addEventListener("click", () => closeDialog(lexicalDialog));
$("lexicalPronounce").addEventListener("click", () => currentLexicalItem && playFile(currentLexicalItem.audio_source));
$("lexicalAdd").addEventListener("click", addCurrentLexicalItem);
$("lexicalOpenVocabulary").addEventListener("click", () => openVocabulary(learningSourceIndex));
$("deepClose").addEventListener("click", () => closeDialog(deepDialog));
$("deepReturn").addEventListener("click", () => closeDialog(deepDialog));
$("deepContinue").addEventListener("click", () => continueFromLearning(learningSourceIndex));
$("deepSentencePicker").addEventListener("change", (event) => {
  const index = Number(event.target.value);
  stopAllAudioBeforeLearning();
  learningSourceIndex = index;
  renderDeepStudy(index);
  trackTrainerEvent("sentence_selected", { sentence_id: data.sentences[index].sentence_id, story_order: index + 1, source: "deep_study_picker" });
});
$("deepEnglishAudio").addEventListener("click", () => playFile(data.sentences[selectedIndex].english_audio));
$("deepUkrainianAudio").addEventListener("click", () => playFile(data.sentences[selectedIndex].ukrainian_audio));
$("vocabularyOpen").addEventListener("click", () => openVocabulary(selectedIndex));
$("vocabularyClose").addEventListener("click", () => closeDialog(vocabularyDialog));
$("vocabularyReturn").addEventListener("click", () => closeDialog(vocabularyDialog));
$("vocabularyContinue").addEventListener("click", () => continueFromLearning(learningSourceIndex));
$("vocabularyClear").addEventListener("click", () => { stopAllAudioBeforeLearning(); clearVocabularyWithConfirmation(); });
$("builderOpen").addEventListener("click", () => openSentenceBuilder(selectedIndex, false));
$("builderClose").addEventListener("click", () => closeDialog(builderDialog));
$("builderReturn").addEventListener("click", () => closeDialog(builderDialog));
$("builderContinue").addEventListener("click", () => continueFromLearning(builderIndex));
$("translationMode").addEventListener("click", () => selectBuilderMode("translation"));
$("listeningMode").addEventListener("click", () => selectBuilderMode("listening"));
$("builderPlayAudio").addEventListener("click", playBuilderAudio);
$("builderShowTranslation").addEventListener("click", revealBuilderTranslation);
$("builderCheck").addEventListener("click", checkBuilderAnswer);
$("builderReset").addEventListener("click", resetBuilderRound);
$("builderTryAgain").addEventListener("click", () => {
  $("builderResult").textContent = "";
  $("builderResult").className = "builder-result";
  $("builderTryAgain").hidden = true;
});
$("builderPlayAgain").addEventListener("click", () => {
  resetBuilderRound();
  playBuilderAudio();
});
$("builderProgressReset").addEventListener("click", () => resetBuilderProgressWithConfirmation());
$("builderStudy").addEventListener("click", () => {
  stopAllAudioBeforeLearning();
  builderDialog.close();
  openDeepStudy(builderIndex);
});
[lexicalDialog, deepDialog, vocabularyDialog, builderDialog].forEach((dialog) => {
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog(dialog);
  });
});
[$("builderSegmentBank"), $("builderAnswer")].forEach((zone) => {
  zone.addEventListener("dragover", (event) => event.preventDefault());
  zone.addEventListener("drop", (event) => handleBuilderDrop(event, zone.id === "builderAnswer" ? "answer" : "bank"));
});

async function runPrototypeSelfTest() {
  const checks = [];
  const check = (condition, name) => {
    if (!condition) throw new Error(`Self-test failed: ${name}`);
    checks.push(name);
  };
  const key = storageKey();
  const backup = localStorage.getItem(key);
  const builderKey = builderStorageKey();
  const builderBackup = localStorage.getItem(builderKey);
  try {
    localStorage.removeItem(key);
    loadVocabulary();
    updateVocabularyCount();
    check(vocabulary.size === 0, "vocabulary starts empty");
    check(document.querySelectorAll(".sentence-card").length === data.sentence_count, "all sentence units rendered");
    check(document.querySelectorAll(".lexical-item").length === data.supported_lexical_item_count, "all supported lexical items rendered");

    const first = data.sentences[0].lexical_items[0];
    openLexicalItem(first);
    check(lexicalDialog.open && $("lexicalUkrainian").textContent === first.contextual_translation, "lexical panel uses approved data");
    addCurrentLexicalItem();
    addCurrentLexicalItem();
    check(vocabulary.size === 1, "duplicate vocabulary add prevented");
    vocabulary = new Set();
    loadVocabulary();
    check(vocabulary.size === 1 && vocabulary.has(first.item_id), "vocabulary survives reload logic");
    check(!clearVocabularyWithConfirmation(() => false) && vocabulary.size === 1, "clear requires confirmation");
    check(clearVocabularyWithConfirmation(() => true) && vocabulary.size === 0, "confirmed clear works");
    lexicalDialog.close();

    data.sentences.forEach((scene, index) => {
      renderDeepStudy(index);
      check($("deepBlocks").children.length === Math.max(scene.deep_study_blocks.length, scene.ukrainian_study_blocks.length), `deep study sentence ${index + 1}`);
      check($("deepEnglish").textContent === scene.english && $("deepUkrainian").textContent === scene.ukrainian, `deep study content ${index + 1}`);
    });
    const unrestrictedIndex = Math.min(4, data.sentences.length - 1);
    selectSentence(unrestrictedIndex);
    check(selectedIndex === unrestrictedIndex && document.querySelectorAll(".sentence-card")[unrestrictedIndex].classList.contains("selected"), "unrestricted sentence selection");

    localStorage.removeItem(builderKey);
    loadBuilderProgress();
    const finalIndex = data.sentences.length - 1;
    chooseBuilderSentence(finalIndex);
    selectBuilderMode("translation");
    check(builderBank.length === data.sentences[finalIndex].deep_study_blocks.length, "final sentence builder uses every approved English block");
    builderAnswer = approvedBuilderSegments(data.sentences[finalIndex]);
    builderBank = [];
    renderBuilderSegments();
    checkBuilderAnswer();
    check($("builderResult").classList.contains("correct"), "final sentence builder canonical answer passes");
    const completedFinal = builderProgress.sentences[data.sentences[finalIndex].sentence_id];
    check(completedFinal?.completed_modes.includes("translation") && completedFinal.attempt_count === 1, "builder progress uses stable sentence ID");

    const sources = new Set();
    data.sentences.forEach((scene) => {
      sources.add(scene.english_audio.path);
      sources.add(scene.ukrainian_audio.path);
      scene.deep_study_blocks.forEach((block) => {
        sources.add(block.english_audio.path);
      });
      scene.ukrainian_study_blocks.forEach((block) => sources.add(block.ukrainian_audio.path));
    });
    const responses = await Promise.all([...sources].map((source) => fetch(source, { cache: "no-store" })));
    check(responses.length === data.audio_file_count && responses.every((response) => response.ok), "all audio assets load");
    check(document.body.scrollWidth <= window.innerWidth, "no horizontal viewport overflow");

    const output = document.createElement("pre");
    output.id = "prototypeSelfTestResult";
    output.textContent = JSON.stringify({ status: "PASS", checks, viewport: [window.innerWidth, window.innerHeight] });
    document.body.append(output);
  } finally {
    if (backup === null) localStorage.removeItem(key); else localStorage.setItem(key, backup);
    if (builderBackup === null) localStorage.removeItem(builderKey); else localStorage.setItem(builderKey, builderBackup);
    vocabulary = new Set();
    loadVocabulary();
    updateVocabularyCount();
  }
}

const startup = start();
startup.then(() => {
  if (new URLSearchParams(location.search).get("selftest") === "1") {
    runPrototypeSelfTest().catch((error) => {
      const output = document.createElement("pre");
      output.id = "prototypeSelfTestResult";
      output.textContent = JSON.stringify({ status: "FAIL", error: error.message });
      document.body.append(output);
    });
  }
}).catch((error) => {
  console.error(error);
  sentenceList.textContent = "English Story Workspace data could not be loaded.";
});
