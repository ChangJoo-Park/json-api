import mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

export default function(Organization, OrganizationSchema) {
  //School extends Organization,
  //adding the following properties
  const schema = new OrganizationSchema({
    isCollege: Boolean,
    principal: { ref: "Person", type: ObjectId },
  });

  schema.statics.findCollegeIds = function() {
    return this.find({isCollege: true}, "_id").lean().exec()
      .then(function(members) {
        if(!members.length) {
          return undefined;
        }
        else {
          return members.reduce(function(prev, curr) {
            prev.push(curr._id.toString());
            return prev;
          }, []);
        }
      });
  };

  return Organization.discriminator("School", schema);
}
