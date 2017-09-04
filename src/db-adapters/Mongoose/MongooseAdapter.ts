import mongodb = require("mongodb");
import mongoose = require("mongoose");
import pluralize = require("pluralize");

import { arrayContains } from "../../util/arrays";
import { deleteNested } from "../../util/misc";
import {forEachArrayOrVal, mapResources, groupResourcesByType} from "../../util/type-handling";
import * as util from "./lib";
import Resource, { ResourceWithId } from "../../types/Resource";
import Collection from "../../types/Collection";
import Linkage from "../../types/Linkage";
import Relationship from "../../types/Relationship";
import APIError from "../../types/APIError";
import FieldDocumentation from "../../types/Documentation/Field";
import FieldTypeDocumentation from "../../types/Documentation/FieldType";
import RelationshipTypeDocumentation from "../../types/Documentation/RelationshipType";
import { Adapter } from '../AdapterInterface';
import CreateQuery from "../../types/Query/CreateQuery";
import FindQuery from "../../types/Query/FindQuery";
import DeleteQuery from "../../types/Query/DeleteQuery";
import UpdateQuery from "../../types/Query/UpdateQuery";
import AddToRelationshipQuery from "../../types/Query/AddToRelationshipQuery";
import RemoveFromRelationshipQuery from "../../types/Query/RemoveFromRelationshipQuery";

export default class MongooseAdapter implements Adapter<typeof MongooseAdapter> {
  // Workaround for https://github.com/Microsoft/TypeScript/issues/3841.
  // Doing this makes our implements declaration work.
  "constructor": typeof MongooseAdapter;

  public models: {[modelName: string]: mongoose.Model<any>};
  public inflector: typeof pluralize;
  public idGenerator: (doc: mongoose.Document) => mongodb.ObjectID

  constructor(models?: {[modelName: string]: mongoose.Model<any>}, inflector?, idGenerator?) {
    this.models = models || <{[modelName: string]: mongoose.Model<any>}>(<any>mongoose).models;
    this.inflector = inflector || pluralize;
    this.idGenerator = idGenerator;
  }

  /**
   * Returns a Promise for an array of 3 items: the primary resources (either
   * a single Resource or a Collection); the included resources, as an array;
   * and the size of the full collection, if the primary resources represent
   * a paginated view of some collection.
   *
   * Note: The correct behavior if idOrIds is an empty array is to return no
   * documents, as happens below. If it's undefined, though, we're not filtering
   * by id and should return all documents.
   */
  find(query: FindQuery) {
    const {
      using: type,
      populates: includePaths,
      select: fields,
      sort: sorts,
      offset,
      limit,
    } = query

    const idOrIds = query.getIdOrIds();
    const otherFilters = query.getFilters(true);
    const isFiltering = otherFilters.value.length > 0;
    const mongofiedFilters = util.toMongoCriteria(otherFilters);

    const model = this.getModel(this.constructor.getModelName(type));
    const [mode, idQuery] = this.constructor.getIdQueryType(idOrIds);
    const pluralizer = this.inflector.plural;
    const isPaginating = typeof idOrIds !== 'string' &&
      (typeof offset !== 'undefined' || typeof limit !== 'undefined');

    let primaryDocumentsPromise, includedResourcesPromise;

    const queryBuilder = mode === 'findOne' // ternary is a hack for TS compiler
      ? model[mode](idQuery)
      : model[mode](idQuery);

    // a promised query result that counts how many results we'd have if
    // we weren't paginating. this just resolves to null when we aren't paginating.
    const collectionSizePromise = isPaginating
      ? model.count(mongofiedFilters).exec()
      : Promise.resolve(null);

    // do sorting
    if(Array.isArray(sorts)) {
      queryBuilder.sort(
        sorts.map(it => (it.direction === 'DESC' ? '-' : '') + it.field).join(" ")
      );
    }

    // filter out invalid records with simple fields equality.
    // note that there's a non-trivial risk of sql-like injection here.
    // we're mostly protected by the fact that we're treating the filter's
    // value as a single string, though, and not parsing as JSON.
    if(isFiltering) {
      queryBuilder.where(mongofiedFilters);
    }

    if(offset) {
      queryBuilder.skip(offset);
    }

    if(limit) {
      queryBuilder.limit(limit);
    }

    // in an ideal world, we'd use mongoose here to filter the fields before
    // querying. But, because the fields to filter can be scoped by type and
    // we don't always know about a document's type until after query (becuase
    // of discriminator keys), and because filtering out fields can really
    // complicate population for includes, we don't yet filter at query time but
    // instead just hide filtered fields in @docToResource. There is a more-
    // efficient way to do this down the road, though--something like taking the
    // provided fields and expanding them just enough (by looking at the type
    // heirarachy and the relationship paths) to make sure that we're not going
    // to run into any of the problems outlined above, while still querying for
    // less data than we would without any fields restriction. For reference, the
    // code for safely using the user's `fields` input, by putting them into a
    // mongoose `.select()` object so that the user can't prefix a field with a
    // minus on input to affect the query, is below.
    // Reference: http://mongoosejs.com/docs/api.html#query_Query-select.
    // let arrToSelectObject = (prev, curr) => { prev[curr] = 1; return prev; };
    // for(let type in fields) {
    //   fields[type] = fields[type].reduce(arrToSelectObject, {});
    // }

    // support includes, but only a level deep for now (recursive includes,
    // especially if done in an efficient way query wise, are a pain in the ass).
    if(includePaths) {
      const populatedPaths: string[] = [];
      const refPaths = util.getReferencePaths(model);

      includePaths.map((it) => it.split(".")).forEach((pathParts) => {
        // first, check that the include path is valid.
        if(!arrayContains(refPaths, pathParts[0])) {
          const title = "Invalid include path.";
          const detail = `Resources of type "${type}" don't have a(n) "${pathParts[0]}" relationship.`;
          throw new APIError(400, undefined, title, detail);
        }

        if(pathParts.length > 1) {
          throw new APIError(501, undefined, "Multi-level include paths aren't yet supported.");
        }

        // Finally, do the population
        populatedPaths.push(pathParts[0]);
        queryBuilder.populate(pathParts[0]);
      });

      const includedResources: Resource[] = [];
      primaryDocumentsPromise = Promise.resolve(queryBuilder.exec()).then((docs) => {
        forEachArrayOrVal(docs, (doc) => {
          // There's no gaurantee that the doc (or every doc) was found
          // and we can't populate paths on a non-existent doc.
          if(!doc) {
            return;
          }

          populatedPaths.forEach((path) => {
            // if it's a toOne relationship, doc[path] will be a doc or undefined;
            // if it's a toMany relationship, we have an array (or undefined).
            const refDocs = Array.isArray(doc[path]) ? doc[path] : [doc[path]];
            refDocs.forEach((it) => {
              // only include if it's not undefined.
              if(it) {
                includedResources.push(
                  this.constructor.docToResource(it, pluralizer, fields)
                );
              }
            });
          });
        });

        return docs;
      });

      includedResourcesPromise = primaryDocumentsPromise.then(() =>
        new Collection(includedResources)
      );
    }

    else {
      primaryDocumentsPromise = Promise.resolve(queryBuilder.exec());
      includedResourcesPromise = Promise.resolve(null);
    }

    return Promise.all([primaryDocumentsPromise.then((it) => {
      const makeCollection = !idOrIds || Array.isArray(idOrIds) ? true : false;
      return this.constructor.docsToResourceOrCollection(it, makeCollection, pluralizer, fields);
    }), includedResourcesPromise, collectionSizePromise]).catch(util.errorHandler);
  }

  /**
   * Returns a Promise that fulfills with the created Resource. The Promise
   * may also reject with an error if creation failed or was unsupported.
   *
   * @param {string} parentType - All the resources to be created must be this
   *   type or be sub-types of it.
   * @param {(Resource|Collection)} resourceOrCollection - The resource or
   *   collection of resources to create.
   */
  create(query: CreateQuery) {
    const { records: resourceOrCollection } = query;
    const resourcesByType = groupResourcesByType(resourceOrCollection);

    // Note: creating the resources as we do below means that we do one
    // query for each type, as opposed to only one query for all of the
    // documents. That's unfortunately much slower, but it ensures that
    // mongoose runs all the user's hooks.
    const creationPromises: Array<Promise<mongoose.Document[]>> = [];
    const setIdWithGenerator = (doc) => { doc._id = this.idGenerator(doc); };

    // tslint:disable-next-line:forin
    for(const type in resourcesByType) {
      const model = this.getModel(this.constructor.getModelName(type));
      const resources: Resource[] = resourcesByType[type];
      const docObjects = resources.map(util.resourceToDocObject);

      if(typeof this.idGenerator === "function") {
        forEachArrayOrVal(docObjects, setIdWithGenerator);
      }

      creationPromises.push(model.create(docObjects));
    }

    return Promise.all(creationPromises).then((docArrays) => {
      const makeCollection = resourceOrCollection instanceof Collection;
      const finalDocs = docArrays.reduce((a, b) => a.concat(b), []);
      // TODO: why isn't fields passed here, but is only passed in find...
      // is that appropriate? (Probably... check spec, and common sense.)
      return this.constructor.docsToResourceOrCollection(
        finalDocs, makeCollection, this.inflector.plural
      );
    }).catch(util.errorHandler);
  }

  /**
   * @param {string} parentType - All the resources to be created must be this
   *   type or be sub-types of it.
   * @param {Object} resourceOrCollection - The changed Resource or Collection
   *   of resources. Should only have the fields that are changed.
   */
  update(query: UpdateQuery) {
    const { using: parentType, patch: resourceOrCollection } = query;
    const singular = this.inflector.singular;
    const plural = this.inflector.plural;

    const parentModel = this.getModel(this.constructor.getModelName(parentType, singular));
    //const parentModelDiscriminatorKey = parentModel && parentModel.schema
    //  && (<any>parentModel.schema).options
    //  && (<any>parentModel.schema).options.discriminatorKey;

    const updateOptions = {
      new: true,
      runValidators: true,
      context: 'query',
      upsert: false
    };

    const updatedResourcePromiseOrPromises =
      mapResources(resourceOrCollection, (resourceUpdate: ResourceWithId) => {
        const newModelName = this.constructor.getModelName(resourceUpdate.type, singular);
        const NewModelConstructor = this.getModel(newModelName);
        const changeSet = util.resourceToDocObject(resourceUpdate);

        // run the fields to change through the doc constructor so mongoose
        // will run any setters, but then remove any keys that weren't changed
        // by the update itself (i.e., keys for which the doc constructor set
        // defaults), to create the final update.
        const updateDoc = NewModelConstructor.hydrate({}).set(changeSet);
        const modifiedPaths = updateDoc.modifiedPaths();
        const updateDocObject = updateDoc.toObject();
        const finalUpdate = modifiedPaths.reduce((acc, key) => {
          acc[key] = updateDocObject[key];
          return acc;
        }, {
          // The user may have attempted to change the resource's `type`,
          // so we try to update the type in the db as well.
          // Note: this is currently ignored by mongoose :(
          // See https://github.com/Automattic/mongoose/issues/5613
          // ...(parentModelDiscriminatorKey
          //   ? { [parentModelDiscriminatorKey]: newModelName }
          //   : undefined)
        });

        return parentModel
          .findByIdAndUpdate(resourceUpdate.id, finalUpdate, updateOptions)
          .exec();
      });

    const updatedResourcePromises = Array.isArray(updatedResourcePromiseOrPromises)
      ? updatedResourcePromiseOrPromises
      : [updatedResourcePromiseOrPromises];

    return Promise.all(updatedResourcePromises).then((docs) => {
      const makeCollection = resourceOrCollection instanceof Collection;
      return this.constructor.docsToResourceOrCollection(docs, makeCollection, plural);
    }).catch(util.errorHandler);
  }

  delete(query: DeleteQuery) {
    const { using: parentType } = query;
    const idOrIds = query.getIdOrIds();

    const model = this.getModel(this.constructor.getModelName(parentType));
    const [mode, idQuery] = this.constructor.getIdQueryType(idOrIds);

    if(!idOrIds) {
      return Promise.reject(
        new APIError(400, undefined, "You must specify some resources to delete")
      );
    }

    const queryBuilder = mode === 'findOne' // ternary is a hack for TS compiler
      ? model[mode](idQuery)
      : model[mode](idQuery);

    return Promise.resolve(queryBuilder.exec()).then((docs) => {
      if(!docs) {
        throw new APIError(404, undefined, "No matching resource found.");
      }

      forEachArrayOrVal(docs, (it) => { it.remove(); });
      return docs;
    }).catch(util.errorHandler);
  }

  /**
   * Unlike update(), which would do full replacement of a to-many relationship
   * if new linkage was provided, this method adds the new linkage to the existing
   * relationship. It doesn't do a find-then-save, so some mongoose hooks may not
   * run. But validation and the update query hooks will work if you're using
   * Mongoose 4.0.
   */
  addToRelationship(query: AddToRelationshipQuery) {
    const {
      using: type,
      resourceId: id,
      relationshipName: relationshipPath,
      linkage: newLinkage
    } = query;

    const model = this.getModel(this.constructor.getModelName(type));
    const update = {
      $addToSet: {
        [relationshipPath]: { $each: newLinkage.value.map(it => it.id)}
      }
    };
    const options = {runValidators: true, context: 'query'};

    return model.findOneAndUpdate({"_id": id}, update, options).exec()
      .catch(util.errorHandler);
  }

  removeFromRelationship(query: RemoveFromRelationshipQuery) {
    const {
      using: type,
      resourceId: id,
      relationshipName: relationshipPath,
      linkage: linkageToRemove
    } = query;

    const model = this.getModel(this.constructor.getModelName(type));
    const update = {
      $pullAll: {
        [relationshipPath]: linkageToRemove.value.map(it => it.id)
      }
    };
    const options = {runValidators: true, context: 'query'};

    return model.findOneAndUpdate({"_id": id}, update, options).exec()
      .catch(util.errorHandler);
  }

  getModel(modelName) {
    if(!this.models[modelName]) {
      // don't use an APIError here, since we don't want to
      // show this internals-specific method to the user.
      const err = new Error(`The model "${modelName}" has not been registered with the MongooseAdapter.`);
      (<any>err).status = 404;
      throw err;
    }
    return this.models[modelName];
  }

  getTypesAllowedInCollection(parentType) {
    const parentModel = this.getModel(
      this.constructor.getModelName(parentType, this.inflector.singular)
    );
    return [parentType].concat(
      this.constructor.getChildTypes(parentModel, this.inflector.plural)
    );
  }

  /**
   * Return the paths that, for the provided type, must always must be filled
   * with relationship info, if they're present. Occassionally, a path might be
   * optionally fillable w/ relationship info; this shouldn't return those paths.
   */
  getRelationshipNames(type) {
    const model = this.getModel(
      this.constructor.getModelName(type, this.inflector.singular)
    );
    return util.getReferencePaths(model);
  }

  doQuery(
    query: CreateQuery | FindQuery | UpdateQuery | DeleteQuery |
      AddToRelationshipQuery | RemoveFromRelationshipQuery
  ) {
    const method = (
      (query instanceof CreateQuery && this.create) ||
      (query instanceof FindQuery && this.find) ||
      (query instanceof DeleteQuery && this.delete) ||
      (query instanceof UpdateQuery && this.update) ||
      (query instanceof AddToRelationshipQuery && this.addToRelationship) ||
      (query instanceof RemoveFromRelationshipQuery && this.removeFromRelationship)
    );

    if(!method) {
      throw new Error("Unexpected query type.");
    }

    return method.call(this, query);
  }

  /**
   * We want to always return a collection when the user is asking for something
   * that's logically a Collection (even if it only has 1 item), and a Resource
   * otherwise. But, because mongoose returns a single doc if you query for a
   * one-item array of ids, and because we sometimes generate arrays (e.g. of
   * promises for documents' successful creation) even when only creating/updating
   * one document, just looking at whether docs is an array isn't enough to tell
   * us whether to return a collection or not. And, in all these cases, we want
   * to handle the possibility that the query returned no documents when we needed
   * one, such that we must 404. This function centralizes all that logic.
   *
   * @param docs The docs to turn into a resource or collection
   * @param makeCollection Whether we're making a collection.
   * @param pluralizer An inflector function for setting the Resource's type
   */
  static docsToResourceOrCollection(docs, makeCollection, pluralizer, fields?: object): Collection | Resource {
    // if docs is an empty array and we're making a collection, that's ok.
    // but, if we're looking for a single doc, we must 404 if we didn't find any.
    if(!docs || (!makeCollection && Array.isArray(docs) && docs.length === 0)) {
      throw new APIError(404, undefined, "No matching resource found.");
    }

    docs = !Array.isArray(docs) ? [docs] : docs;
    docs = docs.map((it) => this.docToResource(it, pluralizer, fields));
    return makeCollection ? new Collection(docs) : docs[0];
  }

  // Useful to have this as static for calling as a utility outside this class.
  static docToResource(doc, pluralizer = pluralize.plural, fields?: object) {
    const type = this.getType(doc.constructor.modelName, pluralizer);
    const refPaths = util.getReferencePaths(doc.constructor);
    const schemaOptions = doc.constructor.schema.options;

    // Get and clean up attributes
    // Note: we can't use the depopulate attribute because it doesn't just
    // depopulate fields _inside_ the passed in doc, but can actually turn the
    // doc itself into a string if the doc was originally gotten by population.
    // That's stupid, and it breaks our include handling.
    // Also, starting in 4.0, we won't need the delete versionKey line:
    // https://github.com/Automattic/mongoose/issues/2675
    let attrs = doc.toJSON({virtuals: true, getters: true});
    delete attrs.id; // from the id virtual.
    delete attrs._id;
    delete attrs[schemaOptions.versionKey];
    delete attrs[schemaOptions.discriminatorKey];

    // Delete attributes that aren't in the included fields.
    // TODO: Some virtuals could be expensive to compute, so, if field
    // restrictions are in use, we shouldn't set {virtuals: true} above and,
    // instead, we should read only the virtuals that are needed (by searching
    // the schema to identify the virtual paths and then checking those against
    // fields) and add them to newAttrs.
    if(fields && fields[type]) {
      const newAttrs = {};
      fields[type].forEach((field) => {
        if(attrs[field]) {
          newAttrs[field] = attrs[field];
        }
      });
      attrs = newAttrs;
    }

    // Build relationships
    const relationships = {};
    const getProp = (obj, part) => obj[part];

    refPaths.forEach((path) => {
      // skip if applicable
      if(fields && fields[type] && !arrayContains(fields[type], path)) {
        return;
      }

      // get value at the path w/ the reference, in both the json'd + full docs.
      const pathParts = path.split(".");
      let jsonValAtPath = pathParts.reduce(getProp, attrs);
      const referencedType = this.getReferencedType(doc.constructor, path);

      // delete the attribute, since we're moving it to relationships
      deleteNested(path, attrs);

      // Now, since the value wasn't excluded, we need to build its
      // Relationship. Note: the value could still be null or an empty array.
      // And, because of population, it could be a single document or array of
      // documents, in addition to a single/array of ids. So, as is customary,
      // we'll start by coercing it to an array no matter what, tracking
      // whether to make it a non-array at the end, to simplify our code.
      let isToOneRelationship = false;

      if(!Array.isArray(jsonValAtPath)) {
        jsonValAtPath = [jsonValAtPath];
        isToOneRelationship = true;
      }

      let linkage: typeof Linkage.prototype.value = [];
      jsonValAtPath.forEach((docOrIdOrNull) => {
        // if docOrIdOrNull has an ._id key, it's a document
        const idOrNull = (docOrIdOrNull && docOrIdOrNull._id)
          // so the id (if it exists) is in ._id as an ObjectId
          ? String(docOrIdOrNull._id)

          // otherwise, we're dealing with an id directly (if we
          // don't have null), but we still need to convert to a
          // string because, even though we did toJSON(), id may
          // be an ObjectId. (lame.)
          : docOrIdOrNull ? String(docOrIdOrNull) : null;

        linkage.push(idOrNull ? {type: referencedType, id: idOrNull} : null);
      });

      // go back from an array if neccessary and save.
      linkage = new Linkage(isToOneRelationship ? linkage[0] : linkage);
      relationships[path] = new Relationship(linkage);
    });

    // finally, create the resource.
    return new Resource(type, doc.id, attrs, relationships);
  }

  static getModelName(type, singularizer = pluralize.singular) {
    const words = type.split("-");
    words[words.length - 1] = singularizer(words[words.length - 1]);
    return words.map((it) => it.charAt(0).toUpperCase() + it.slice(1)).join("");
  }

  // Get the json api type name for a model.
  static getType(modelName, pluralizer = pluralize.plural) {
    return pluralizer(modelName.replace(/([A-Z])/g, "\-$1").slice(1).toLowerCase());
  }

  static getReferencedType(model, path, pluralizer = pluralize.plural) {
    return this.getType(util.getReferencedModelName(model, path), pluralizer);
  }

  static getChildTypes(model, pluralizer = pluralize.plural) {
    if(!model.discriminators) {
      return [];
    }

    return Object.keys(model.discriminators).map(it => this.getType(it, pluralizer));
  }

  static getStandardizedSchema(model, pluralizer = pluralize.plural) {
    const schemaOptions = model.schema.options;
    const versionKey = schemaOptions.versionKey;
    const discriminatorKey = schemaOptions.discriminatorKey;
    const virtuals = model.schema.virtuals;
    const schemaFields: FieldDocumentation[] = [];

    const getFieldType = (path, schemaType) => {
      if(path === "_id") {
        return new FieldTypeDocumentation("Id", false);
      }


      const typeOptions = schemaType.options.type;
      const holdsArray = Array.isArray(typeOptions);

      const baseType = holdsArray ? typeOptions[0].ref : typeOptions.name;
      const refModelName = util.getReferencedModelName(model, path);

      return !refModelName ?
        new FieldTypeDocumentation(baseType, holdsArray) :
        new RelationshipTypeDocumentation(
          holdsArray, refModelName, this.getType(refModelName, pluralizer)
        );

    };

    model.schema.eachPath((name, type) => {
      if(arrayContains([versionKey, discriminatorKey], name)) {
        return;
      }

      const fieldType = getFieldType(name, type);
      name = (name === "_id") ? "id" : name;
      const likelyAutoGenerated = name === "id" || (
        fieldType.baseType === "Date" &&
        /created|updated|modified/.test(name) &&
        typeof type.options.default === "function"
      );

      let defaultVal;
      if(likelyAutoGenerated) {
        defaultVal = "__AUTO__";
      }

      else if(type.options.default && typeof type.options.default !== "function") {
        defaultVal = type.options.default;
      }

      // find the "base type's" options (used below), in case
      // we have an array of values of the same type at this path.
      const baseTypeOptions = Array.isArray(type.options.type) ? type.options.type[0] : type.options;

      // Add validation info
      const validationRules = {
        required: !!type.options.required,
        oneOf: baseTypeOptions.enum ? type.enumValues || (type.caster && type.caster.enumValues) : undefined,
        max: type.options.max || undefined
      };

      type.validators.forEach((validatorObj) => {
        Object.assign(validationRules, validatorObj.validator.JSONAPIDocumentation);
      });

      schemaFields.push(new FieldDocumentation(
        name,
        fieldType,
        validationRules,
        this.toFriendlyName(name),
        defaultVal
      ));
    });

    for(const virtual in virtuals) {
      // skip the id virtual, since we properly handled _id above.
      if(virtual === "id") {
        continue;
      }

      // for virtual properties, we can't infer type or validation rules at all,
      // so we add them with just a friendly name and leave the rest undefined.
      // The user is expected to override/set this in a resource type description.
      schemaFields.push(new FieldDocumentation(
        virtual,
        undefined,
        undefined,
        this.toFriendlyName(virtual)
      ));
    }
    return schemaFields;
  }

  static toFriendlyName(pathOrModelName: string) {
    const ucFirst = (v) => v.charAt(0).toUpperCase() + v.slice(1);

    // pascal case is "upper camel case", i.e. "MyName" as opposed to "myName".
    // this variable holds a normalized, pascal cased version of pathOrModelName,
    // such that `ModelFormat`, `pathFormat` `nested.path.format` all become
    // ModelFormat, PathFormat, and NestedPathFormat.
    const pascalCasedString = pathOrModelName.split(".").map(ucFirst).join("");

    // Now, to handle acronyms like InMLBTeam, we need to define a word as a
    // capital letter, plus (0 or more capital letters where the capital letter
    // is not followed by a non-capital letter or 0 or more non capital letters).
    let matches;
    const words: string[] = [];
    const wordsRe = /[A-Z]([A-Z]*(?![^A-Z])|[^A-Z]*)/g;

    while((matches = wordsRe.exec(pascalCasedString)) !== null) {
      words.push(matches[0]);
    }

    return words.join(" ");
  }

  /*
  Note: adding overloads here creates more (false) compile errors than it fixes,
  because of issues like https://github.com/Microsoft/TypeScript/issues/10523
  static getIdQueryType(ids: string[]): ["find", {_id: {$in: string[]}}];
  static getIdQueryType(id: string): ["findOne", {_id: string}];
  static getIdQueryType(id: undefined): ["find", {}];
  static getIdQueryType(): ["find", {}];*/
  static getIdQueryType(idOrIds: string | string[] | undefined) {
    type result =
      ["findOne", {_id: string}] | // one resource
      ["find", {_id: {$in: string[]}}] | // set of resources
      ["find", {}]; // all resources in collection

    const [mode, idQuery, idsArray] = <result & { 2?: string[] }>(() => {
      if(Array.isArray(idOrIds)) {
        return ["find", {_id: {"$in": idOrIds}}, idOrIds];
      }

      else if(typeof idOrIds === "string" && idOrIds) {
        return ["findOne", {_id: idOrIds}, [idOrIds]];
      }

      else {
        return ["find", {}, undefined];
      }
    })();

    if (idsArray && !idsArray.every(this.idIsValid)) {
      throw Array.isArray(idOrIds)
        ? new APIError(400, undefined, "Invalid ID.")
        : new APIError(404, undefined, "No matching resource found.", "Invalid ID.");
    }

    return <result>[mode, idQuery];
  }

  static idIsValid(id) {
    return typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id);
  }
}
