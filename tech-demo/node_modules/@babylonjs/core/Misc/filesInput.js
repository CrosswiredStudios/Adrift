import { SceneLoader } from "../Loading/sceneLoader.js";
import { Logger } from "../Misc/logger.js";
import { FilesInputStore } from "./filesInputStore.js";
import { SceneLoaderFlags } from "../Loading/sceneLoaderFlags.js";
/**
 * Class used to help managing file picking and drag-n-drop
 */
export class FilesInput {
    /**
     * List of files ready to be loaded
     */
    static get FilesToLoad() {
        return FilesInputStore.FilesToLoad;
    }
    /**
     * Creates a new FilesInput
     * @param engine defines the rendering engine
     * @param scene defines the hosting scene
     * @param sceneLoadedCallback callback called when scene (files provided) is loaded
     * @param progressCallback callback called to track progress
     * @param additionalRenderLoopLogicCallback callback called to add user logic to the rendering loop
     * @param textureLoadingCallback callback called when a texture is loading
     * @param startingProcessingFilesCallback callback called when the system is about to process all files
     * @param onReloadCallback callback called when a reload is requested
     * @param errorCallback callback call if an error occurs
     * @param useAppend defines if the file loaded must be appended (true) or have the scene replaced (false, default behavior)
     * @param dontInjectRenderLoop defines if the render loop mustn't be injected into engine (default is false). Used only if useAppend is false.
     */
    constructor(engine, scene, sceneLoadedCallback, progressCallback, additionalRenderLoopLogicCallback, textureLoadingCallback, startingProcessingFilesCallback, onReloadCallback, errorCallback, useAppend = false, dontInjectRenderLoop = false) {
        this.useAppend = useAppend;
        this.dontInjectRenderLoop = dontInjectRenderLoop;
        /**
         * Callback called when a file is processed
         * @returns false to abort the process
         */
        this.onProcessFileCallback = () => {
            return true;
        };
        /**
         * Callback called when an accepted file selection does not contain a loadable scene.
         */
        this.onProcessFilesErrorCallback = () => { };
        /**
         * If a loading UI should be displayed while loading a file
         */
        this.displayLoadingUI = true;
        /**
         * Function used when loading the scene file
         * @param sceneFile defines the file to load
         * @param onProgress onProgress callback called while loading the file
         * @returns a promise completing when the load is complete
         */
        this.loadAsync = async (sceneFile, onProgress) => this.useAppend
            ? await SceneLoader.AppendAsync("file:", sceneFile, this._currentScene, onProgress)
            : await SceneLoader.LoadAsync("file:", sceneFile, this._engine, onProgress);
        this._sceneFileToLoad = null;
        this._filesToLoad = [];
        this._fileSelectionGeneration = 0;
        this._reloadGeneration = 0;
        this._isLoading = false;
        this._renderLoop = () => {
            this._renderFunction();
        };
        this._engine = engine;
        this._currentScene = scene;
        this._sceneLoadedCallback = sceneLoadedCallback;
        this._progressCallback = progressCallback;
        this._additionalRenderLoopLogicCallback = additionalRenderLoopLogicCallback;
        this._textureLoadingCallback = textureLoadingCallback;
        this._startingProcessingFilesCallback = startingProcessingFilesCallback;
        this._onReloadCallback = onReloadCallback;
        this._errorCallback = errorCallback;
    }
    /**
     * Calls this function to listen to drag'n'drop events on a specific DOM element
     * @param elementToMonitor defines the DOM element to track
     */
    // should probably be DragAndDrop
    // eslint-disable-next-line @typescript-eslint/naming-convention
    monitorElementForDragNDrop(elementToMonitor) {
        if (elementToMonitor) {
            this._elementToMonitor = elementToMonitor;
            this._dragEnterHandler = (e) => {
                this._drag(e);
            };
            this._dragOverHandler = (e) => {
                this._drag(e);
            };
            this._dropHandler = (e) => {
                this._drop(e);
            };
            this._elementToMonitor.addEventListener("dragenter", this._dragEnterHandler, false);
            this._elementToMonitor.addEventListener("dragover", this._dragOverHandler, false);
            this._elementToMonitor.addEventListener("drop", this._dropHandler, false);
        }
    }
    /** Gets the current list of files to load */
    get filesToLoad() {
        return this._filesToLoad;
    }
    /**
     * Clears the files and scene selection associated with the current load.
     * @param cancelActiveLoad whether an in-progress replacement load should be canceled, restoring FilesInput-managed loading UI and rendering
     */
    clearFileSelection(cancelActiveLoad = true) {
        this._fileSelectionGeneration++;
        if (cancelActiveLoad) {
            this._reloadGeneration++;
        }
        this._sceneFileToLoad = null;
        this._filesToLoad = [];
        if (cancelActiveLoad && this._isLoading) {
            this._restoreCurrentScene();
        }
    }
    /**
     * Release all associated resources
     */
    dispose() {
        if (!this._elementToMonitor) {
            return;
        }
        this._elementToMonitor.removeEventListener("dragenter", this._dragEnterHandler);
        this._elementToMonitor.removeEventListener("dragover", this._dragOverHandler);
        this._elementToMonitor.removeEventListener("drop", this._dropHandler);
    }
    _renderFunction() {
        if (this._additionalRenderLoopLogicCallback) {
            this._additionalRenderLoopLogicCallback();
        }
        if (this._currentScene) {
            if (this._textureLoadingCallback) {
                const remaining = this._currentScene.getWaitingItemsCount();
                if (remaining > 0) {
                    this._textureLoadingCallback(remaining);
                }
            }
            this._currentScene.render();
        }
    }
    _restoreCurrentScene() {
        this._isLoading = false;
        if (this.displayLoadingUI) {
            this._engine.hideLoadingUI();
        }
        if (!this.useAppend && !this.dontInjectRenderLoop && this._currentScene) {
            this._engine.runRenderLoop(this._renderLoop);
        }
    }
    _drag(e) {
        e.stopPropagation();
        e.preventDefault();
    }
    _drop(eventDrop) {
        eventDrop.stopPropagation();
        eventDrop.preventDefault();
        this.loadFiles(eventDrop);
    }
    _traverseFolder(folder, files, remaining, callback) {
        const reader = folder.createReader();
        const relativePath = folder.fullPath.replace(/^\//, "").replace(/(.+?)\/?$/, "$1/");
        const completeEntry = () => {
            if (--remaining.count === 0) {
                callback();
            }
        };
        const readNextBatch = () => {
            reader.readEntries((entries) => {
                if (entries.length === 0) {
                    completeEntry();
                    return;
                }
                remaining.count += entries.length;
                for (const entry of entries) {
                    if (entry.isFile) {
                        entry.file((file) => {
                            file.correctName = relativePath + file.name;
                            files.push(file);
                            completeEntry();
                        }, (error) => {
                            Logger.Error(`Unable to read dropped file '${entry.fullPath}': ${error.message}`);
                            completeEntry();
                        });
                    }
                    else if (entry.isDirectory) {
                        this._traverseFolder(entry, files, remaining, callback);
                    }
                    else {
                        completeEntry();
                    }
                }
                // DirectoryReader may return large folders in several batches.
                readNextBatch();
            }, (error) => {
                Logger.Error(`Unable to read dropped folder '${folder.fullPath}': ${error.message}`);
                completeEntry();
            });
        };
        readNextBatch();
    }
    _processFiles(files) {
        for (let i = 0; i < files.length; i++) {
            const name = (files[i].correctName || files[i].webkitRelativePath || files[i].name).replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
            const extension = name.split(".").pop();
            if (!this.onProcessFileCallback(files[i], name, extension, (sceneFile) => (this._sceneFileToLoad = sceneFile))) {
                continue;
            }
            if (SceneLoader.IsPluginForExtensionAvailable("." + extension)) {
                this._sceneFileToLoad = files[i];
            }
            FilesInput.FilesToLoad[name] = files[i];
        }
    }
    /**
     * Load files from a drop event
     * @param event defines the drop event to use as source
     */
    loadFiles(event) {
        const dataTransferItems = event?.dataTransfer?.items;
        let filesToLoad = [];
        // Handling data transfer via drag'n'drop
        if (event && event.dataTransfer && event.dataTransfer.files) {
            filesToLoad = Array.from(event.dataTransfer.files);
        }
        // Handling files from input files
        if (event && event.target && event.target.files) {
            filesToLoad = Array.from(event.target.files);
        }
        if (filesToLoad.length === 0 && (!dataTransferItems || dataTransferItems.length === 0)) {
            return;
        }
        const files = [];
        const folders = [];
        if (dataTransferItems?.length) {
            for (let index = 0; index < dataTransferItems.length; index++) {
                const item = dataTransferItems[index];
                if (item.kind && item.kind !== "file") {
                    continue;
                }
                const entry = item.getAsEntry?.() ?? item.webkitGetAsEntry?.();
                if (entry?.isDirectory) {
                    folders.push(entry);
                    continue;
                }
                const file = item.getAsFile?.();
                if (file) {
                    const fileWithPath = file;
                    fileWithPath.correctName = (entry?.fullPath || file.webkitRelativePath || file.name).replace(/\\/g, "/").replace(/^\/+/, "");
                    files.push(file);
                }
            }
        }
        if (files.length === 0 && folders.length === 0) {
            for (let i = 0; i < filesToLoad.length; i++) {
                const fileToLoad = filesToLoad[i];
                const relativePath = fileToLoad.correctName || fileToLoad.webkitRelativePath || fileToLoad.name;
                fileToLoad.correctName = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
                files.push(fileToLoad);
            }
        }
        if (files.length === 0 && folders.length === 0) {
            return;
        }
        const fileSelectionGeneration = ++this._fileSelectionGeneration;
        if (!this.useAppend) {
            this._reloadGeneration++;
        }
        this._sceneFileToLoad = null;
        if (folders.length === 0) {
            this._processLoadedFiles(files, fileSelectionGeneration);
        }
        else {
            const remaining = { count: folders.length };
            for (const folder of folders) {
                this._traverseFolder(folder, files, remaining, () => {
                    if (remaining.count === 0) {
                        this._processLoadedFiles(files, fileSelectionGeneration);
                    }
                });
            }
        }
    }
    _processLoadedFiles(files, fileSelectionGeneration) {
        if (fileSelectionGeneration !== this._fileSelectionGeneration) {
            return;
        }
        if (files.length === 0) {
            this._restoreCurrentScene();
            this.onProcessFilesErrorCallback(files);
            return;
        }
        this._sceneFileToLoad = null;
        this._filesToLoad = files;
        this._startingProcessingFilesCallback?.(files);
        this._processFiles(files);
        if (!this._sceneFileToLoad) {
            this._restoreCurrentScene();
            this.onProcessFilesErrorCallback(files);
        }
        this._processReload();
    }
    _processReload() {
        if (this._onReloadCallback && this._sceneFileToLoad) {
            this._onReloadCallback(this._sceneFileToLoad);
        }
        else {
            this.reload();
        }
    }
    /**
     * Reload the current scene from the loaded files
     */
    reload() {
        // If a scene file has been provided
        if (this._sceneFileToLoad) {
            const sceneFileToLoad = this._sceneFileToLoad;
            const reloadGeneration = ++this._reloadGeneration;
            if (!this.useAppend) {
                this._isLoading = true;
                if (this._currentScene) {
                    if (Logger.errorsCount > 0) {
                        Logger.ClearLogCache();
                    }
                    this._engine.stopRenderLoop();
                }
            }
            SceneLoaderFlags.ShowLoadingScreen = false;
            if (this.displayLoadingUI) {
                this._engine.displayLoadingUI();
            }
            this.loadAsync(sceneFileToLoad, this._progressCallback)
                // eslint-disable-next-line github/no-then
                .then((scene) => {
                if (!this.useAppend && reloadGeneration !== this._reloadGeneration) {
                    scene.dispose();
                    return;
                }
                // if appending do nothing
                if (!this.useAppend) {
                    if (this._currentScene) {
                        this._currentScene.dispose();
                    }
                    this._currentScene = scene;
                    // Wait for textures and shaders to be ready
                    this._currentScene.executeWhenReady(() => {
                        if (reloadGeneration === this._reloadGeneration) {
                            this._restoreCurrentScene();
                        }
                    });
                }
                else {
                    if (this.displayLoadingUI) {
                        this._engine.hideLoadingUI();
                    }
                }
                if (this._sceneLoadedCallback && this._currentScene) {
                    this._sceneLoadedCallback(sceneFileToLoad, this._currentScene);
                }
            })
                // eslint-disable-next-line github/no-then
                .catch((error) => {
                if (!this.useAppend && reloadGeneration !== this._reloadGeneration) {
                    return;
                }
                this._isLoading = false;
                if (this.displayLoadingUI) {
                    this._engine.hideLoadingUI();
                }
                if (this._errorCallback) {
                    this._errorCallback(sceneFileToLoad, this._currentScene, error.message);
                }
            });
        }
        else {
            if (this._filesToLoad.length === 1) {
                const name = this._filesToLoad[0].name.toLowerCase();
                const extension = name.split(".").pop();
                if (extension) {
                    switch (extension.toLowerCase()) {
                        case "dds":
                        case "env":
                        case "hdr": {
                            return; // Ignore error in that case
                        }
                    }
                }
            }
            Logger.Error("Please provide a valid .babylon file.");
        }
    }
}
//# sourceMappingURL=filesInput.js.map