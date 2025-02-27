import { AccessLevel, ContextProto } from '@eggjs/tegg';
import { ModelConvertor } from './util/ModelConvertor';
import { User as UserModel } from './model/User';
import { Token as TokenModel } from './model/Token';
import { User as UserEntity } from '../core/entity/User';
import { Token as TokenEntity } from '../core/entity/Token';
import { AbstractRepository } from './AbstractRepository';

@ContextProto({
  accessLevel: AccessLevel.PUBLIC,
})
export class UserRepository extends AbstractRepository {
  async saveUser(user: UserEntity): Promise<void> {
    if (user.id) {
      const model = await UserModel.findOne({ id: user.id });
      if (!model) return;
      await ModelConvertor.saveEntityToModel(user, model);
    } else {
      const model = await ModelConvertor.convertEntityToModel(user, UserModel);
      this.logger.info('[UserRepository:saveUser:new] id: %s, userId: %s', model.id, model.userId);
    }
  }

  async findUserByName(name: string) {
    const model = await UserModel.findOne({ name });
    if (!model) return null;
    return ModelConvertor.convertModelToEntity(model, UserEntity);
  }

  async findUserAndTokenByTokenKey(tokenKey: string) {
    const token = await this.findTokenByTokenKey(tokenKey);
    if (!token) return null;
    const userModel = await UserModel.findOne({ userId: token.userId });
    if (!userModel) return null;
    return {
      token,
      user: ModelConvertor.convertModelToEntity(userModel, UserEntity),
    };
  }

  async findTokenByTokenKey(tokenKey: string) {
    const model = await TokenModel.findOne({ tokenKey });
    if (!model) return null;
    return ModelConvertor.convertModelToEntity(model, TokenEntity);
  }

  async saveToken(token: TokenEntity): Promise<void> {
    if (token.id) {
      const model = await TokenModel.findOne({ id: token.id });
      if (!model) return;
      await ModelConvertor.saveEntityToModel(token, model);
    } else {
      const model = await ModelConvertor.convertEntityToModel(token, TokenModel);
      this.logger.info('[UserRepository:saveToken:new] id: %s, tokenId: %s', model.id, model.tokenId);
    }
  }

  async removeToken(tokenId: string) {
    const removeCount = await TokenModel.remove({ tokenId });
    this.logger.info('[UserRepository:removeToken:remove] %d rows, tokenId: %s',
      removeCount, tokenId);
  }

  async listTokens(userId: string): Promise<TokenEntity[]> {
    const models = await TokenModel.find({ userId });
    return models.map(model => ModelConvertor.convertModelToEntity(model, TokenEntity));
  }
}
