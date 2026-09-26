import { type Animatable, type AnimationGroup, type Bone, type IDisposable, type Nullable, type RuntimeAnimation } from "../index.js";
import { Animation } from "./animation.pure.js";
import { Vector3 } from "../Maths/math.vector.pure.js";
import { Observable } from "../Misc/observable.pure.js";
import { TransformNode } from "../Meshes/transformNode.pure.js";
/**
 * Where the travel of a {@link RootMotionClip} comes from.
 */
export declare enum RootMotionSource {
    /**
     * No motion was found: the clip neither moves its root nor walks its contact nodes.
     */
    None = 0,
    /**
     * The root node's own animation - the clip's ground truth. Its travel (and turning, when extracted) is left out of
     * the in-place animation group and applied to the character node instead.
     */
    Root = 1,
    /**
     * Deduced from the contact nodes (usually the feet) of an in-place clip: whatever a planted contact gives up in
     * character space, the character travels. The travel is not in the clip, so nothing is left out of it.
     */
    FootContact = 2
}
/**
 * Options for {@link RootMotionClip}.
 */
export interface IRootMotionClipOptions {
    /**
     * The root node, usually the hips or a dedicated root bone, whose own travel is tried first. A bone is resolved to
     * its linked transform node. Defaults to the position-animated node with the most animated descendants in the group.
     * A node the group does not animate is accepted as the base of the animated hierarchy: the travel then comes from
     * the contact nodes under it, and {@link RootMotionSource.Root} cannot be forced.
     */
    rootNode?: TransformNode | Bone;
    /**
     * The node that receives the motion and whose local space the motion is measured in. Defaults to the topmost
     * ancestor of the root node (the "__root__" node of a glTF asset). The group must not animate its position or
     * rotation, since the motion applied to it would be overwritten.
     */
    characterNode?: TransformNode;
    /**
     * The nodes that touch the ground, used when the root does not travel. A bone is resolved to its linked
     * transform node. Defaults to the leaf nodes under the root that come closest to the ground during the clip.
     */
    contactNodes?: Array<TransformNode | Bone>;
    /**
     * Forces the source of the travel instead of trying {@link RootMotionSource.Root} first and falling back to
     * {@link RootMotionSource.FootContact}.
     */
    source?: RootMotionSource;
    /**
     * Whether the root's turning about the up axis is extracted and applied to the character. By default it is when
     * a cycle leaves the character facing at least {@link IRootMotionClipOptions.minimumTurn} away from where it
     * started, so a walk's hip twist - or a dance that spins round to face the front again - stays in the pose while a
     * turning clip turns the character.
     */
    extractRotation?: boolean;
    /**
     * How densely the clip is sampled during analysis. Default is 60 samples per second of animation.
     */
    samplesPerSecond?: number;
    /**
     * Travel below this share of the character's height over a cycle is treated as the clip standing still: root
     * sway rather than root motion. Default is 0.1.
     */
    minimumTravel?: number;
    /**
     * Turning below this angle over a cycle, in radians, is treated as twist rather than a turn. Default is 10 degrees.
     */
    minimumTurn?: number;
    /**
     * A straight clip whose direction of travel is within this angle of a character space axis, in radians, travels
     * along that axis; 0 keeps the measured direction. Ignored when lateral motion is extracted.
     *
     * By default a root clip keeps its direction (0): its travel is authored or captured, and a deliberate veer is data.
     * Travel deduced from contacts snaps within 10 degrees: an in-place clip is meant to travel straight, and the
     * deduced direction is an estimate - Xbot's run deduces 3.5 degrees off straight from feet that slide 1 degree off.
     */
    directionSnapAngle?: number;
    /**
     * When false (the default) only the travel along the clip's direction of travel is extracted, leaving the
     * side-to-side sway of the root in the animation. Set to true to extract all horizontal motion, for strafing
     * clips. Turning clips always extract all horizontal motion, since their direction of travel changes.
     */
    extractLateralMotion?: boolean;
    /**
     * The up axis in character space. Default is +Y.
     */
    upAxis?: Vector3;
    /**
     * The name of the in-place animation group. Defaults to the source group's name followed by " (in place)".
     */
    name?: string;
    /**
     * Whether every animation is cloned into the in-place animation group. By default (false) only the root channels
     * the extraction rewrites are cloned, and the animations it leaves untouched are shared with the source group, as
     * {@link AnimationGroup.clone} shares them. Set it to true before changing the in-place group's animations in place
     * - with {@link AnimationGroup.MakeAnimationAdditive} or {@link AnimationGroup.normalize} for example - so the
     * source group's animations are not changed with them.
     */
    cloneAnimations?: boolean;
}
/**
 * What the animation mixer wrote to a root channel in the last animation step - the writes its late bindings read,
 * those made after them belonging to the step that follows - gathered for every clip that follows that channel.
 */
interface IChannelWriters {
    /** The property of the channel. */
    property: string;
    /** The weights of the weighted animatables writing the channel, additive ones aside. */
    total: number;
    /** Whether any weighted animatable writes the channel. */
    weighted: boolean;
    /** The last runtime animation writing the channel unweighted, whose value is the pose unless a weighted one replaces it. */
    lastDirect: Nullable<RuntimeAnimation>;
    /** The writes to the channel this step, in order: the runtime animation of each, which may write more than once. */
    current: RuntimeAnimation[];
    /** The weight of each write, -1 for a direct one. */
    currentWeights: number[];
    /** Whether each write was additive. */
    currentAdditive: boolean[];
    /** The factor each write blended in with, one once the animation writing it has blended in. */
    currentBlending: number[];
}
/**
 * The root motion of an animation group: how far the clip carries the character over a cycle, and how far it turns it,
 * so that the character can be moved by it and its feet stay planted instead of skating.
 *
 * The clip is analyzed once, when the RootMotionClip is created, without playing the group or changing it:
 * 1. The root node's own animation is tried first, as the ground truth. If the root ends a cycle a meaningful distance
 *    from where it started, that travel is the root motion. Turning is read from the root the same way.
 * 2. Otherwise the clip is treated as an in-place cycle and the travel is deduced from its contact nodes: a planted
 *    contact stays put in the world, so in character space it moves opposite to the character, and whatever it gives
 *    up the character gains. The direction of travel falls out of the same measurement, so the forward axis of
 *    the rig does not have to be known.
 *
 * The source group is never changed. The clip owns {@link RootMotionClip.animationGroup}, a clone of the source in
 * which the root's travel and turning are left out, so it plays and loops in place: play that group, and give the clip
 * to the {@link RootMotionController} of the character so the motion is applied to the character node instead.
 *
 * ```ts
 * const walk = new RootMotionClip(walkGroup);
 * const controller = new RootMotionController(walk.characterNode, [walk]);
 * walk.animationGroup.start(true);
 * ```
 *
 * The in-place group is a group of the scene, not of the source's asset container, so dispose the clip when it is done
 * with; disposing the container does not. To play a clip additively, build it from the source as it is and make the
 * in-place group additive: `AnimationGroup.MakeAnimationAdditive(clip.animationGroup, { referenceFrame: 0 })`, with
 * {@link IRootMotionClipOptions.cloneAnimations} set so the source keeps its keys.
 */
export declare class RootMotionClip implements IDisposable {
    /**
     * @internal
     * The node of the clip's clock: the channel whose runtime animation the controller reads the evaluated progress
     * from and turns into motion. It is the root node, or the first animated transform node when the group animates
     * no position.
     */
    _clockNode: Nullable<TransformNode>;
    /** @internal The property of the clock's channel. */
    _clockProperty: string;
    /** @internal The very channel of the in-place group the analysis ran on, which another of the same property must not be taken for. */
    _clockAnimation: Nullable<Animation>;
    /** @internal The runtime animation of the clock the controller followed last. */
    _clockRuntime: Nullable<RuntimeAnimation>;
    /** @internal The animatable of the clock the controller followed last. */
    _clockAnimatable: Nullable<Animatable>;
    /** @internal The animatable the last search for the clock found. */
    _foundAnimatable: Nullable<Animatable>;
    /** @internal The animatable the clock's playback was synchronized with last, and the runtime animation of that root. */
    _syncRoot: Nullable<Animatable>;
    /** @internal The runtime animation the clock was synchronized with last. */
    _syncRuntime: Nullable<RuntimeAnimation>;
    /** @internal The progress of the clock the controller consumed last. */
    _lastProgress: Nullable<number>;
    /** @internal Whether the clock has been left unevaluated at a weight of zero since the progress consumed last. */
    _parked: boolean;
    /** @internal The clock's runtime animation at the last reset, whose evaluation of then is not where the playback carries on from. */
    _staleRuntime: Nullable<RuntimeAnimation>;
    /** @internal Its progress then. */
    _staleProgress: Nullable<number>;
    /** @internal What the mixer wrote to the clock's channel this frame. */
    _writers: Nullable<IChannelWriters>;
    /** @internal The controller the clip belongs to. */
    _controller: Nullable<RootMotionController>;
    private readonly _sourceGroup;
    private readonly _group;
    private readonly _characterNode;
    private readonly _upAxis;
    private readonly _extractLateral;
    private readonly _directionSnapAngle;
    /** Sideways travel over a cycle left in the root's keys after snapping the direction, removed without being applied. */
    private readonly _lateralDrift;
    private readonly _channels;
    private _source;
    private _rootNode;
    private _contactNodes;
    private readonly _travelDirection;
    private readonly _cycleOffset;
    private _cycleRotation;
    private _turns;
    private _duration;
    private _characterHeight;
    private _fromFrame;
    private _toFrame;
    private _sampleCount;
    private _track;
    /** Whether the root's own travel is left out of the in-place group - not so for a clip that only turns on the spot. */
    private _removesRootTravel;
    /** Whether the motion is a turn about the root's starting point: a clip that only turns on the spot. */
    private _pivots;
    /** The root's position before the clip, when the in-place group animates a position the source leaves alone. */
    private _restoredPosition;
    private _clockIndex;
    private _sampleBlend;
    private readonly _lastOffset;
    private readonly _rangeStart;
    private readonly _rangeCycle;
    private readonly _cyclesOffset;
    private readonly _planarStep;
    private readonly _yawQuaternion;
    private readonly _yawMatrix;
    /**
     * The animation group the clip was analyzed from. It is never changed.
     */
    get sourceAnimationGroup(): AnimationGroup;
    /**
     * The in-place animation group to play: a clone of the source with the root motion left out of the root's keys.
     * Animations the extraction does not rewrite are shared with the source unless the clip was created with
     * {@link IRootMotionClipOptions.cloneAnimations}. It belongs to the scene, and is disposed with the clip.
     */
    get animationGroup(): AnimationGroup;
    /**
     * The controller the clip was added to, if any.
     */
    get controller(): Nullable<RootMotionController>;
    /**
     * Where the travel comes from. {@link RootMotionSource.None} when no motion was found.
     */
    get source(): RootMotionSource;
    /**
     * The root node the clip was analyzed with, or null when the group animates no position. It carries the motion
     * only when {@link RootMotionClip.source} is {@link RootMotionSource.Root}.
     */
    get rootNode(): Nullable<TransformNode>;
    /**
     * The node the motion is measured in the local space of, and that a controller moves.
     */
    get characterNode(): TransformNode;
    /**
     * The contact nodes used to deduce the travel. Empty unless the source is {@link RootMotionSource.FootContact}.
     */
    get contactNodes(): ReadonlyArray<TransformNode>;
    /**
     * The up axis in character space (unit length).
     */
    get upAxis(): Vector3;
    /**
     * The first frame of the range the clip is analyzed over: the group's range, with a bound outside the clock
     * channel's keys replaced by that channel's first or last key, as playback does.
     */
    get fromFrame(): number;
    /**
     * The last frame of the range the clip is analyzed over.
     */
    get toFrame(): number;
    /**
     * The direction the clip travels in over a cycle, in character space (unit length).
     */
    get travelDirection(): Vector3;
    /**
     * The travel covered by one cycle of the clip, in character space.
     */
    get cycleOffset(): Vector3;
    /**
     * The distance covered by one cycle of the clip along the direction of travel, in character space units.
     */
    get cycleDistance(): number;
    /**
     * The turn covered by one cycle of the clip about the up axis, in radians. Zero unless rotation is extracted.
     */
    get cycleRotation(): number;
    /**
     * Whether the root's turning is extracted and applied to the character.
     */
    get extractsRotation(): boolean;
    /**
     * The length of one cycle of the clip in seconds, at a speed ratio of 1.
     */
    get duration(): number;
    /**
     * The speed the clip implies at a speed ratio of 1, in character space units per second.
     */
    get averageSpeed(): number;
    /**
     * The vertical extent of the animated hierarchy at the first frame, in character space units. Thresholds are
     * relative to it.
     */
    get characterHeight(): number;
    /**
     * Analyzes an animation group and builds the in-place animation group to play instead of it.
     * @param animationGroup defines the animation group to extract the root motion of; it is not changed
     * @param options defines how the root motion is extracted
     * @throws when the group has nothing to analyze, is additive, or animates the character node itself
     */
    constructor(animationGroup: AnimationGroup, options?: IRootMotionClipOptions);
    /**
     * Gets the travel reached at a frame of the clip, relative to its first frame, in character space.
     * @param frame defines the frame to sample
     * @param result defines the vector receiving the travel
     * @returns the result vector
     */
    getOffsetAtFrame(frame: number, result: Vector3): Vector3;
    /**
     * Gets the turn reached at a frame of the clip about the up axis, relative to its first frame, in radians.
     * @param frame defines the frame to sample
     * @returns the turn in radians
     */
    getRotationAtFrame(frame: number): number;
    /**
     * Removes the clip from its controller and disposes the in-place animation group. The source group is untouched.
     * When the in-place group animates the root's position although the source does not (a root that only turns), the
     * root's position is put back to what it was when the clip was created.
     */
    dispose(): void;
    /**
     * @internal
     * Finds the runtime animation of the clock in the in-place group's current playback, leaving its animatable in
     * _foundAnimatable.
     * @returns the runtime animation once it has been evaluated, or null when the group is not playing the clock
     */
    _findClock(): Nullable<RuntimeAnimation>;
    /**
     * @internal
     * Forgets the playback the controller was following.
     */
    _forgetPlayback(): void;
    /**
     * @internal
     * The motion between two progresses of a playback over a range, as a turn and then a translation in the character
     * space of the earlier progress. Progress is unwrapped: whole cycles are in it, however many passed.
     * @param from defines the first frame of the played range
     * @param to defines the last frame of the played range
     * @param lastProgress defines the earlier progress, in frames from the first frame
     * @param progress defines the later progress, in frames from the first frame
     * @param result defines the vector receiving the translation
     * @returns the turn in radians
     */
    _motionBetween(from: number, to: number, lastProgress: number, progress: number, result: Vector3): number;
    /**
     * The motion at a frame relative to the motion at the start of the played range.
     * @param frame defines the frame
     * @param startYaw defines the turn at the start of the range
     * @param startOffset defines the travel at the start of the range
     * @param result defines the vector receiving the travel
     * @returns the turn
     */
    private _motionInRange;
    /**
     * A whole number of cycles of a planar motion - a turn about the up axis and then a translation - in closed form,
     * for any number of cycles, forwards or back: the sum of the horizontal translation turned 0, 1, ... n-1 times is
     * the translation turned (n - 1) / 2 times, sin(n * turn / 2) / sin(turn / 2) times as long, and n times the
     * translation when there is no turn. The vertical part adds up. Nothing here is a matter of precision: no series
     * is summed and no small angle is divided by.
     * @param cycles defines the number of cycles, negative to go back
     * @param step defines the translation of one cycle
     * @param stepYaw defines the turn of one cycle
     * @param result defines the vector receiving the translation of all the cycles
     * @returns the turn of all the cycles
     */
    private _cyclePower;
    private _measureRootYaw;
    private _measureRootTravel;
    /**
     * The travel removed from the root at a pose, so that the in-place root keeps the start position (turning) or its
     * sway (straight).
     * @param position defines the root position in character space
     * @param start defines the root position in character space at the first frame
     * @param yaw defines the turn at this pose
     * @param turning defines whether turning is extracted
     * @param result defines the vector receiving the travel
     * @returns the result vector
     */
    private _rootTravelAt;
    private _measureContactTravel;
    /**
     * Clones the source group into the in-place group. When the root motion is in the root's keys, the root's channels
     * are cloned with the motion left out: each key's pose, in character space, has the motion at its frame undone. The
     * motion is the root's travel for a {@link RootMotionSource.Root} clip, plus the turn when rotation is extracted.
     * Everything is computed from the source keys, which are not touched.
     * @param name defines the name of the in-place group
     * @param cloneAnimations defines whether every animation is cloned rather than only the rewritten root channels
     * @returns the in-place group
     */
    private _buildInPlaceGroup;
    private _findRootNode;
    private _measureHeight;
    /**
     * The track sample before a frame; the blend towards the next one is left in _sampleBlend.
     * @param frame defines the frame
     * @returns the sample index
     */
    private _sampleAt;
    private _frameAt;
    private _horizontal;
    private _project;
    /**
     * Snaps the direction of travel onto the nearest horizontal character space axis within the snap angle.
     * @param defaultAngle defines the snap angle when none was given in the options
     */
    private _snapTravelDirection;
    private _rotateAboutUp;
    /**
     * The turn about the up axis from a reference orientation to a rotation, both in character space: the angle of the
     * rotation about the up axis that best matches the change of orientation. Unlike the twist of a swing-twist split,
     * it stays well defined while the root pitches and rolls - a dancer's hips tilting through the vertical made the
     * twist jump by half turns.
     * @param rotation defines the rotation
     * @param referenceConjugate defines the conjugate of the reference rotation
     * @returns the angle in radians, between -PI and PI
     */
    private _twist;
    private _positionInCharacter;
    private _rotationInCharacter;
    /**
     * Composes a node's transform into character space at a frame of the clip, from the evaluated keys of animated
     * nodes and the current transform of the others. Nothing is played or written.
     * @param node defines the node, or null for the character space itself
     * @param frame defines the frame to evaluate
     * @param result defines the matrix receiving the transform
     * @returns the result matrix
     */
    private _matrixToCharacter;
    private _localMatrix;
    private _resolveNode;
    private _firstAnimatedNode;
    private _topmostAncestor;
}
/**
 * Moves and turns a character node by the root motion of the clips playing on it, once per animation step - from the
 * scene's onAfterAnimationsObservable, so after animations are evaluated and before the world matrices are computed.
 *
 * The motion of each clip follows the playback of its in-place group's root animation: the progress of the pose it
 * evaluated, so pausing, speed ratio changes, looping in every loop mode, forwards and backwards, playing a range,
 * synchronizing with another animatable and running to the end all move the character exactly as far as the pose went.
 * Clips playing together are blended the way the animation mixer blends their root pose: weighted animation groups
 * contribute their share, normalized once their weights add up to more than one, additive groups add theirs on top,
 * an unweighted group contributes its whole pose only while no weighted group animates the root (among unweighted
 * groups the last to write wins), and a group blending in contributes as much as it is blended in, so the character
 * moves with the blended pose whatever the clips do. The turn is blended as a weighted sum of the clips' turns.
 *
 * ```ts
 * const controller = new RootMotionController(character, [walk, run]);
 * walk.animationGroup.start(true);
 * run.animationGroup.start(true);
 * walk.animationGroup.weight = 0.3;
 * run.animationGroup.weight = 0.7;
 * ```
 */
export declare class RootMotionController implements IDisposable {
    /**
     * Gets or sets whether the motion is applied to the character node every frame. Set it to false to consume
     * {@link RootMotionController.deltaPosition} and {@link RootMotionController.deltaRotation} yourself, for example
     * to drive a physics character controller.
     */
    applyToCharacter: boolean;
    /**
     * Notified every animation step the clips produce motion, after {@link RootMotionController.deltaPosition} and
     * {@link RootMotionController.deltaRotation} are updated.
     */
    readonly onRootMotionObservable: Observable<RootMotionController>;
    private readonly _characterNode;
    private readonly _clips;
    private readonly _sceneRootMotion;
    private _upAxis;
    private readonly _deltaPosition;
    private _deltaRotation;
    private readonly _frameDelta;
    private _frameYaw;
    private readonly _clipDelta;
    /**
     * The node the motion is applied to.
     */
    get characterNode(): TransformNode;
    /**
     * The clips whose motion moves the character.
     */
    get clips(): ReadonlyArray<RootMotionClip>;
    /**
     * The travel of the last animation step, in world space; applied to the character unless
     * {@link RootMotionController.applyToCharacter} is false.
     */
    get deltaPosition(): Vector3;
    /**
     * The turn of the last animation step about the up axis, in radians; applied to the character unless
     * {@link RootMotionController.applyToCharacter} is false.
     */
    get deltaRotation(): number;
    /**
     * Creates a controller for a character node.
     * @param characterNode defines the node to move: the character node of the clips
     * @param clips defines the clips to add
     */
    constructor(characterNode: TransformNode, clips?: RootMotionClip[]);
    /**
     * Adds a clip, so the character moves while its in-place group plays.
     * @param clip defines the clip; its character node must be the controller's
     * @throws when the clip belongs to another controller, moves another node, or has another up axis than the clips
     * already added
     */
    addClip(clip: RootMotionClip): void;
    /**
     * Removes a clip. Its in-place group keeps playing, in place.
     * @param clip defines the clip
     */
    removeClip(clip: RootMotionClip): void;
    /**
     * Forgets where the playbacks were last measured. Call after jumping a group with goToFrame or resetting it, so the
     * jump is not read as motion. Starting a group again needs no reset.
     */
    reset(): void;
    /**
     * Stops applying the motion and lets the clips go. The clips and their groups are not disposed.
     */
    dispose(): void;
    /**
     * @internal
     * Applies the motion of this frame, once the mixer's writers of the clips' channels are gathered.
     * @param animated defines whether the scene animated this step at all; when it did not, nothing moved and nothing
     * is read into the clips' playbacks
     */
    _update(animated: boolean): void;
    /**
     * Adds a clip's motion between two progresses of a playback into this frame's motion, weighted the way the mixer
     * weighs the pose of the playback.
     * @param clip defines the clip
     * @param runtime defines the runtime animation of the clip's clock
     * @param lastProgress defines the progress consumed before
     * @param progress defines the progress to consume
     * @returns whether anything was added
     */
    private _accumulate;
    /**
     * The share of a playback in the pose the mixer wrote to its channel this step, following the late animation
     * bindings of the scene: an unweighted animatable writes directly and the last one wins, unless a weighted animatable
     * also animates the channel, in which case the weighted ones replace it - normalized once their weights add up to
     * more than one - and additive ones add their weight on top. A playback that ran to its end this step is among the
     * writers like any other, from its place in the order they wrote; one that did not write this step has no share;
     * one that wrote more than once - re-evaluated by an animation event, say - has the share of all its writes, as the
     * bindings add them up. A playback still blending in wrote that much of its pose, so the share follows the factor
     * its last write blended in with, taken from the record of that write rather than from the animation, whose own
     * factor a write made since the step may have moved on.
     * @param writers defines what the mixer wrote to the clip's channel this step
     * @param runtime defines the runtime animation of the clip's clock
     * @returns the share, between 0 and 1
     */
    private _effectiveWeight;
}
export {};
