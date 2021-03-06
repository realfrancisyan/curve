import * as mongoose from 'mongoose';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import * as moment from 'moment';
import * as _ from 'underscore';
import fetch from 'node-fetch';
import { Context } from 'koa';
import { coreCollections } from '../../config/database';
import config from '../../config';
import constants from '../../config/constants';
import { decodeJwt } from '../../middleware/auth';

const schema = new mongoose.Schema(
  {
    username: String,
    password: String,
    role: Number,
    createdAt: String,
    email: String,
    openid: String,
    appId: String,
  },
  {
    toObject: { virtuals: true },
    toJSON: { virtuals: true },
  }
);

// Generate virtual field 'id' that returns _id.toString()
schema.virtual('uid').get(function () {
  return this._id;
});

export const UserModel = coreCollections.model('users', schema);

/**
 * Validate username
 * @param username username
 */
const validateUsername = (username: string) => {
  const re = /^[a-zA-Z0-9_-]{4,16}$/;
  return re.test(username);
};

/**
 * Validate email address
 * @param email email address
 */
const validateEmail = (email: string) => {
  const re = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  return re.test(String(email).toLowerCase());
};

/**
 * Register as new user
 * @param username username
 * @param hashedPassword required when using username && password as login method
 * @param email required when using username && password as login method
 * @param openid required when using WeChat login
 * @param appId required when using WeChat login
 */
const registerAsNewUser = async ({
  username = '',
  hashedPassword = null,
  email = '',
  openid = '',
  appId = '',
} = {}) => {
  let data: genericObject = {
    role: 0, // 0 normal user, 1 administrator
    createdAt: moment().unix(),
  };

  // register with username and password
  if (!openid) {
    data = {
      username: username.toLowerCase(),
      password: hashedPassword,
      email,
      ...data,
    };
  } else {
    // register with WeChat open id
    data = {
      openid,
      appId,
      ...data,
    };
  }

  const newUser = new UserModel(data);
  await newUser.save();
};

/**
 * Generate JWT token
 * @param username
 * @param role
 * @param uid
 */
const generateJWTToken = (user: genericObject) => {
  const { role, uid } = user;
  const token = jwt.sign({ role, uid }, config.database.SECRET, {
    expiresIn: config.tokenExpiration,
  });

  const { exp: expiredAt } = <genericObject>jwt.decode(token);

  const result = {
    token,
    user: _.omit(user.toJSON(), ['_id', '__v', 'password']),
    expiredAt,
  };

  return result;
};

/**
 * Register
 * @param ctx Context
 */
export const register = async (ctx: Context): Promise<void> => {
  if (!config.registrationIsOpen) {
    ctx.throw(403, 'Registration is not open.');
  }

  const { username, password, email } = ctx.request.body;

  if (!validateUsername(username)) {
    ctx.throw(400, 'Invalid username.');
  }

  if (!password) {
    ctx.throw(400, 'Invalid password.');
  }

  if (!validateEmail(email)) {
    ctx.throw(400, 'Invalid email address.');
  }

  const _user = await UserModel.findOne({
    username: username.toLowerCase(),
  });

  if (_user) {
    ctx.throw(409, 'The username has been taken.');
  }

  const hashedPassword = bcrypt.hashSync(password, 10);

  await registerAsNewUser({ username, hashedPassword });

  ctx.response.status = 201;
  ctx.body = `User ${username} has successfully registered.`;
};

/**
 * Login
 * @param ctx Context
 */
export const login = async (ctx: Context): Promise<void> => {
  const { username, password } = ctx.request.body;

  // search user from database
  const _user = await UserModel.findOne({
    username: username.toLowerCase(),
  });

  // validate password
  let hasUser = false;
  const validateUser = () => {
    return new Promise((resolve, reject) => {
      bcrypt.compare(password, _user['password'], (err, result) => {
        if (err) reject(err);
        hasUser = result;
        resolve(!!hasUser);
      });
    });
  };

  if (_user) {
    await validateUser();

    // generate token if account info matches
    if (hasUser) {
      const result = generateJWTToken(_user);
      ctx.response.status = 201;
      ctx.body = result;
      return;
    }
  }

  ctx.throw(401, 'Username and password mismatch.');
};

/**
 * Change password
 * @param ctx Context
 */
export const changePassword = async (ctx: Context): Promise<void> => {
  const { username, password, email } = ctx.request.body;

  if (!validateEmail(email)) {
    ctx.throw(400, 'Invalid email address.');
  }

  const _user = await UserModel.findOne({
    username: username.toLowerCase(),
    email: email.toLowerCase(),
  });

  if (_user) {
    const hashedPassword = bcrypt.hashSync(password, 10);
    const update = { password: hashedPassword };
    await UserModel.findOneAndUpdate({ username }, update);
  } else {
    ctx.throw(
      401,
      `User ${username} is not found or the email given and username mismatch.`
    );
  }
};

/**
 * Sign in with WeChat
 * @param ctx Context
 */
export const signInWithWeChat = async (ctx: Context): Promise<void> => {
  const { code } = ctx.query;

  const appId = ctx.get('appid');
  const appSecret = config['appIds'][appId];

  if (!appId || !appSecret) {
    ctx.throw(
      401,
      'App Id is not found. Make sure your app has been registered.'
    );
  }

  const query = `?appid=${appId}&secret=${appSecret}&js_code=${code}&grant_type=authorization_code`;
  const code2Session = `${constants.THIRD_PARTY_URLS.WECHAT_LOGIN}${query}`;
  const response = await fetch(code2Session);

  const { errcode, errmsg, openid } = await response.json();

  if (!openid) {
    ctx.throw(401, `Login failed. errcode: ${errcode}. ${errmsg}`);
  }

  const user = await UserModel.findOne({ openid, appId });
  // If user is not found, create a new one
  if (!user) {
    await registerAsNewUser({ openid, appId });
  }

  const _user = user || (await UserModel.findOne({ openid, appId }));

  const result = generateJWTToken(_user);
  ctx.body = result;
};

/**
 * Update WeChat user info
 * @param ctx Context
 */
export const updateWeChatUserInfo = async (ctx: Context): Promise<void> => {
  const { userInfo } = ctx.request.body;
  const { uid } = decodeJwt(ctx);

  const appId = ctx.get('appid');
  const appSecret = config['appIds'][appId];

  if (!appId || !appSecret) {
    ctx.throw(
      400,
      'App Id is not found. Make sure your app has been registered.'
    );
  }

  if (!uid) {
    ctx.throw(401, 'You have to sign in to use this feature.');
  }

  const update: genericObject = [
    {
      $set: Object.assign(userInfo, {
        updatedAt: moment().unix(),
        updatedBy: uid,
        appId,
      }),
    },
  ];

  await UserModel.updateOne({ _id: uid }, update);
  const user = await UserModel.findOne({ _id: uid });
  ctx.body = _.omit(user.toJSON(), ['_id', '__v', 'password']);
};
