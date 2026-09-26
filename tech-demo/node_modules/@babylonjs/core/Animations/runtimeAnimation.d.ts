import { type Nullable } from "../types.js";
import { type _IAnimationState, Animation } from "./animation.pure.js";
import { type Animatable } from "./animatable.js";
import { type Scene } from "../scene.js";
/**
 * @internal
 * A write of a runtime animation to one of its targets in an animation step, recorded as it is made.
 */
export interface IRuntimeAnimationWrite {
    /** The runtime animation that wrote; null once the record is emptied, after its step. */
    runtimeAnimation: Nullable<RuntimeAnimation>;
    /** The object it wrote a property of; null once the record is emptied. */
    target: any;
    /** The weight it wrote with, -1 for a direct write. */
    weight: number;
    /** Whether it wrote additively. */
    additive: boolean;
    /** The factor the value it wrote was blended in with, one once the animation has blended in. */
    blendingFactor: number;
    /** Whether a step prologue has already held the record over; a direct write is held over one step and no more. */
    carried: boolean;
}
/**
 * Defines a runtime animation
 */
export declare class RuntimeAnimation {
    private _events;
    /**
     * The current frame of the runtime animation
     */
    private _currentFrame;
    /**
     * The animation used by the runtime animation
     */
    _animation: Animation;
    /**
     * The target of the runtime animation
     */
    private _target;
    /**
     * The initiating animatable
     */
    private _host;
    /**
     * The original value of the runtime animation
     */
    private _originalValue;
    /**
     * The original blend value of the runtime animation
     */
    private _originalBlendValue;
    /**
     * The offsets cache of the runtime animation
     */
    private _offsetsCache;
    /**
     * The high limits cache of the runtime animation
     */
    private _highLimitsCache;
    /**
     * Specifies if the runtime animation has been stopped
     */
    private _stopped;
    /**
     * The blending factor of the runtime animation
     */
    private _blendingFactor;
    /**
     * The BabylonJS scene
     */
    private _scene;
    /**
     * The current value of the runtime animation
     */
    private _currentValue;
    /** @internal */
    _animationState: _IAnimationState;
    /**
     * The active target of the runtime animation
     */
    private _activeTargets;
    private _currentActiveTarget;
    private _directTarget;
    /**
     * The target path of the runtime animation
     */
    private _targetPath;
    /**
     * The weight of the runtime animation
     */
    private _weight;
    /**
     * The absolute frame offset of the runtime animation
     */
    private _absoluteFrameOffset;
    /**
     * The previous elapsed time (since start of animation) of the runtime animation
     */
    private _previousElapsedTime;
    private _yoyoDirection;
    /**
     * The previous absolute frame of the runtime animation (meaning, without taking into account the from/to values, only the elapsed time and the fps)
     */
    private _previousAbsoluteFrame;
    private _playbackFrom;
    private _playbackTo;
    private _playbackFrames;
    private _playbackProgress;
    private _playbackSyncRoot;
    private _playbackJumped;
    private _playbackSyncMasterPlayed;
    private _playbackSyncMasterFrame;
    private _enableBlending;
    private _keys;
    private _minFrame;
    private _maxFrame;
    private _targetIsArray;
    /** @internal */
    _coreRuntimeAnimation: RuntimeAnimation | null;
    /**
     * Gets the current frame of the runtime animation
     */
    get currentFrame(): number;
    /**
     * @internal
     * The first frame of the range the animation was last evaluated over: the requested range, clamped to its keys.
     */
    get _evaluatedFrom(): number;
    /**
     * @internal
     * The last frame of the range the animation was last evaluated over.
     */
    get _evaluatedTo(): number;
    /**
     * @internal
     * How far the pose last evaluated had played from _evaluatedFrom, in frames, unwrapped across loops: folding it into
     * the range gives the frame that was evaluated, and dividing it by the range counts the whole cycles the pose has been
     * through. It follows a synchronization root, swings with a yoyo loop and holds where a constant loop or a playback
     * that does not loop holds its pose, so it always describes the pose that was evaluated.
     */
    get _evaluatedProgress(): number;
    /**
     * @internal
     * The animatable the evaluation was clocked by, captured as it was made: the pose of a step stays that of the root
     * it was synchronized with then, whatever the host has been synchronized with since.
     */
    get _evaluatedSyncRoot(): Nullable<Animatable>;
    /**
     * @internal
     * Whether the evaluated progress jumped rather than playing on from the one before: the pose of a follower snapped
     * back to the start of its range by a root whose own clock cannot carry it to the end.
     */
    get _evaluatedJump(): boolean;
    /**
     * Gets the weight of the runtime animation
     */
    get weight(): number;
    /**
     * Gets the current value of the runtime animation
     */
    get currentValue(): any;
    /**
     * Gets or sets the target path of the runtime animation
     */
    get targetPath(): string;
    /**
     * Gets the actual target of the runtime animation
     */
    get target(): any;
    /**
     * Gets the additive state of the runtime animation
     */
    get isAdditive(): boolean;
    /** @internal */
    _onLoop: () => void;
    /**
     * Create a new RuntimeAnimation object
     * @param target defines the target of the animation
     * @param animation defines the source animation object
     * @param scene defines the hosting scene
     * @param host defines the initiating Animatable
     */
    constructor(target: any, animation: Animation, scene: Scene, host: Animatable);
    private _preparePath;
    /**
     * Gets the animation from the runtime animation
     */
    get animation(): Animation;
    /**
     * Resets the runtime animation to the beginning
     * @param restoreOriginal defines whether to restore the target property to the original value
     */
    reset(restoreOriginal?: boolean): void;
    /**
     * Specifies if the runtime animation is stopped
     * @returns Boolean specifying if the runtime animation is stopped
     */
    isStopped(): boolean;
    /**
     * Disposes of the runtime animation
     */
    dispose(): void;
    /**
     * Apply the interpolated value to the target
     * @param currentValue defines the value computed by the animation
     * @param weight defines the weight to apply to this value (Defaults to 1.0)
     */
    setValue(currentValue: any, weight: number): void;
    private _getOriginalValues;
    private _registerTargetForLateAnimationBinding;
    private _setValue;
    /**
     * Gets the loop pmode of the runtime animation
     * @returns Loop Mode
     */
    private _getCorrectLoopMode;
    /**
     * Move the current animation to a given frame
     * @param frame defines the frame to move to
     * @param weight defines the weight to apply to the animation (-1.0 by default)
     */
    goToFrame(frame: number, weight?: number): void;
    /**
     * @internal Internal use only
     */
    _prepareForSpeedRatioChange(newSpeedRatio: number): void;
    /**
     * Execute the current animation
     * @param elapsedTimeSinceAnimationStart defines the elapsed time (in milliseconds) since the animation was started
     * @param from defines the lower frame of the animation range
     * @param to defines the upper frame of the animation range
     * @param loop defines if the current animation must loop
     * @param speedRatio defines the current speed ratio
     * @param weight defines the weight of the animation (default is -1 so no weight)
     * @returns a boolean indicating if the animation is running
     */
    animate(elapsedTimeSinceAnimationStart: number, from: number, to: number, loop: boolean, speedRatio: number, weight?: number): boolean;
}
