import type { MessageKey } from '../i18n'
import type { TransformId } from '../shell/transform'

export const TRANSFORM_KEYS: Record<TransformId, MessageKey> = {
  sort: 'tf.sort',
  dedupe: 'tf.dedupe',
  trim: 'tf.trim',
  upper: 'tf.upper',
  lower: 'tf.lower',
  indent2: 'tf.indent2',
  indent4: 'tf.indent4',
  tabs: 'tf.tabs',
  removeEmpty: 'tf.removeEmpty',
}
