import System from 'system';

import {summary} from './assert.js';

import './devices.test.js';
import './rules.test.js';
import './patcher.test.js';

System.exit(summary() ? 0 : 1);
